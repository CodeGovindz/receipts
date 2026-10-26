/**
 * Minimal Amazon Bedrock Converse layer.
 *
 * P0 scope: a shared client plus the 4-step response parser needed by the
 * smoke script. The full callJson<T>() wrapper (zod validation, one
 * same-model retry with the validation error fed back, STRONG->FALLBACK
 * failover) arrives in P1 — see docs/PLAN.md for the exact contract.
 *
 * This module must stay framework-free: no Next.js imports, so the CLI,
 * the web app, and the MCP server can all share it.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

/** Input for a single Converse call. */
export interface ConverseCallOptions {
  modelId: string;
  system: string;
  user: string;
  /** Max output tokens. Reasoning models count reasoning tokens against this. */
  maxTokens?: number;
  temperature?: number;
  /** Optional wall-clock timeout for this call in milliseconds. */
  timeoutMs?: number;
}

/** Result of a single Converse call, with the metrics Receipts logs per call. */
export interface ConverseCallResult {
  modelId: string;
  text: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

let cachedClient: BedrockRuntimeClient | null = null;

/**
 * Shared Bedrock client. Region comes from AWS_REGION; credentials come from
 * the SDK default credential chain (so local dev uses the AWS CLI profile
 * and Vercel uses the static env keys).
 *
 * maxAttempts: 3 keeps transient ThrottlingException / 5xx retries on the
 * SAME model, per plan correction 1 — fallback logic is layered on top in P1.
 */
export function getBedrockClient(): BedrockRuntimeClient {
  if (!cachedClient) {
    cachedClient = new BedrockRuntimeClient({
      region: requiredEnv("AWS_REGION", "Set AWS_REGION (e.g. us-east-1) — see .env.example."),
      maxAttempts: 3,
    });
  }
  return cachedClient;
}

function requiredEnv(name: string, hint: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return raw.trim();
}

/**
 * Step 1 of the parse pipeline: read ONLY content blocks that carry a "text"
 * field. Kimi K3 (our STRONG model) emits reasoning before the answer as
 * `reasoningContent` blocks, which must be ignored — never concatenated into
 * the text we later parse as JSON. Cast through `unknown` because SDK type
 * unions vary across @aws-sdk/client-bedrock-runtime versions and the
 * reasoning block type is not present in all of them.
 */
export function textBlocksOnly(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  const parts: string[] = [];
  for (const block of content) {
    const maybeText = block as unknown as { text?: unknown };
    if (typeof maybeText.text === "string") {
      parts.push(maybeText.text);
    }
  }
  return parts.join("\n");
}

/**
 * Step 2: strip a wrapping Markdown code fence (```json ... ``` or ``` ... ```).
 * Kimi K2.5 and Devstral wrap JSON output in fences.
 */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?```$/;
  const match = trimmed.match(fence);
  return match ? match[1].trim() : trimmed;
}

/**
 * Step 3/4: JSON.parse the cleaned text; if it still is not pure JSON, extract
 * the first balanced top-level {...} or [...] block and parse that instead.
 * Throws if neither yields parseable JSON — callers decide how to degrade
 * (P1: same-model retry, then deterministic fallback verdicts).
 */
export function parseModelJson(raw: string): unknown {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const candidate = firstBalancedBlock(cleaned);
    if (candidate === null) {
      throw new Error("parseModelJson: no JSON object or array found in model output.");
    }
    return JSON.parse(candidate);
  }
}

/**
 * Returns the first balanced {...} or [...] block in the text, or null.
 * Tracks string literals and backslash escapes so braces inside strings do
 * not confuse the depth counter. Only the outer bracket type is counted:
 * JSON is well-formed when this returns, so mixed inner brackets are safe.
 */
function firstBalancedBlock(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // Unbalanced construct starting here — try the next candidate.
  }
  return null;
}

/**
 * One Converse call. P0 uses a simple Promise.race timeout so the smoke
 * script can never hang; P1 replaces this with AbortController so the HTTP
 * request is actually cancelled (recorded in docs/PLAN.md).
 */
export async function converse(options: ConverseCallOptions): Promise<ConverseCallResult> {
  const client = getBedrockClient();
  const command = new ConverseCommand({
    modelId: options.modelId,
    system: [{ text: options.system }],
    messages: [{ role: "user", content: [{ text: options.user }] }],
    // Temperature is opt-in: Kimi K3 (reasoning model) rejects the field
    // outright ("This model doesn't support the temperature field"), so the
    // STRONG path must omit it. FAST/FALLBACK pass 0 for determinism.
    inferenceConfig: {
      maxTokens: options.maxTokens ?? 1000,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    },
  });

  const started = Date.now();
  const pending = client.send(command);
  const output =
    options.timeoutMs === undefined
      ? await pending
      : await withTimeoutMs(pending, options.timeoutMs, `${options.modelId} call`);
  return {
    modelId: options.modelId,
    text: textBlocksOnly(output),
    latencyMs: Date.now() - started,
    inputTokens: output.usage?.inputTokens ?? 0,
    outputTokens: output.usage?.outputTokens ?? 0,
  };
}

/** Rejects with a clear timeout error; never leaves a dangling timer. */
function withTimeoutMs<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
