/**
 * Amazon Bedrock Converse layer: shared client, the 4-step response parser,
 * callJson<T>() (parse + zod validate + one same-model retry with the
 * validation error fed back), and callStrong<T>() (STRONG -> FALLBACK
 * failover). Contract details live in docs/PLAN.md §5.
 *
 * This module must stay framework-free: no Next.js imports, so the CLI,
 * the web app, and the MCP server can all share it.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { z } from "zod";

/** Input for a single Converse call. */
export interface ConverseCallOptions {
  modelId: string;
  system: string;
  user: string;
  /** Max output tokens. Reasoning models count reasoning tokens against this. */
  maxTokens?: number;
  /** Opt-in: Kimi K3 (STRONG) rejects the temperature field outright. */
  temperature?: number;
  /** Wall-clock timeout for this call in milliseconds. */
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

/**
 * Thrown when a Converse call is cancelled because it exceeded its wall-clock
 * timeout. Typed so the fallback logic (callStrong) can distinguish timeouts
 * from parse failures, which must never switch models.
 */
export class TimeoutError extends Error {
  readonly timedOutAfterMs: number;
  constructor(message: string, timedOutAfterMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timedOutAfterMs = timedOutAfterMs;
  }
}

/**
 * Thrown when a model's output cannot be parsed/zod-validated even after the
 * one same-model retry. Verification degrades the claim to UNVERIFIED
 * ("model output unparseable"); parse failures never switch models.
 */
export class ModelCallError extends Error {
  readonly modelId: string;
  readonly detail: string;
  constructor(message: string, modelId: string, detail: string) {
    super(message);
    this.name = "ModelCallError";
    this.modelId = modelId;
    this.detail = detail;
  }
}

let cachedClient: BedrockRuntimeClient | null = null;

/**
 * Shared Bedrock client. Region comes from RECEIPTS_AWS_REGION (else
 * AWS_REGION). Credentials come from RECEIPTS_AWS_ACCESS_KEY_ID /
 * RECEIPTS_AWS_SECRET_ACCESS_KEY when both are set — Vercel reserves the
 * plain AWS_* names for its own runtime — and otherwise from the SDK default
 * credential chain (local dev uses the AWS CLI profile).
 *
 * maxAttempts: 3 keeps transient ThrottlingException / 5xx retries on the
 * SAME model, per plan correction 1 — so any such error that still reaches
 * us has already been retried, and callStrong treats it as a failover signal.
 */
export function getBedrockClient(): BedrockRuntimeClient {
  if (!cachedClient) {
    const accessKeyId = process.env.RECEIPTS_AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.RECEIPTS_AWS_SECRET_ACCESS_KEY?.trim();
    cachedClient = new BedrockRuntimeClient({
      region: awsRegion(),
      maxAttempts: 3,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }
  return cachedClient;
}

/** RECEIPTS_AWS_REGION, else AWS_REGION; throws a clear error when neither is set. */
export function awsRegion(): string {
  const region = process.env.RECEIPTS_AWS_REGION?.trim() || process.env.AWS_REGION?.trim();
  if (!region) {
    throw new Error(
      "Missing required environment variable RECEIPTS_AWS_REGION (or AWS_REGION). Set it to e.g. us-east-1 — see .env.example.",
    );
  }
  return region;
}

/** Test hook: drop the cached client so a new one picks up env changes. */
export function resetBedrockClient(): void {
  cachedClient = null;
}

/**
 * Test hook: inject a stub BedrockRuntimeClient so callJson/callStrong
 * (including the failover policy) can be exercised without network access.
 * Passing null restores the real client lazily.
 */
export function setBedrockClientForTesting(client: BedrockRuntimeClient | null): void {
  cachedClient = client;
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
 * Steps 3/4: JSON.parse the cleaned text; if it still is not pure JSON, extract
 * the first balanced top-level {...} or [...] block and parse that instead.
 * Throws if neither yields parseable JSON — callers decide how to degrade
 * (callJson retries once on the same model, then degrades deterministically).
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
 * One Converse call with real cancellation: the timeout drives an
 * AbortController wired into the SDK request options, so the in-flight
 * HTTP request is actually cancelled (replacing P0's Promise.race, which
 * left the request running). On timeout the caller gets a typed
 * TimeoutError; every other error propagates untouched.
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
  let output: ConverseCommandOutput;
  if (options.timeoutMs === undefined) {
    output = await client.send(command);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      output = await client.send(command, { abortSignal: controller.signal });
    } catch (error) {
      // The SDK rejects in several shapes once the signal fires; the aborted
      // flag is the reliable discriminator between a timeout and a real error.
      if (controller.signal.aborted) {
        throw new TimeoutError(
          `${options.modelId} call timed out after ${options.timeoutMs}ms`,
          options.timeoutMs,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    modelId: options.modelId,
    text: textBlocksOnly(output),
    latencyMs: Date.now() - started,
    inputTokens: output.usage?.inputTokens ?? 0,
    outputTokens: output.usage?.outputTokens ?? 0,
  };
}

/** Input to callJson(): a single-model JSON call. Model ID is explicit. */
export interface CallJsonOptions extends Omit<ConverseCallOptions, "modelId"> {
  modelId: string;
}

/** Token usage reported per call (summed across same-model attempts). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Result of a successful callJson / callStrong. */
export interface CallJsonResult<T> {
  data: T;
  /** Bedrock model ID that actually produced the data. */
  modelUsed: string;
  latencyMs: number;
  tokens: TokenUsage;
  attempts: number;
}

/** callStrong() result extras: whether the FALLBACK model had to fire. */
export interface CallStrongResult<T> extends CallJsonResult<T> {
  fallbackUsed: boolean;
  /** Why the STRONG call was abandoned, e.g. "timed out after 45000ms". */
  fallbackReason?: string;
}

/** Options for callStrong(): STRONG with fallback policy per plan §5. */
export interface CallStrongOptions {
  strongModelId: string;
  fallbackModelId: string;
  system: string;
  user: string;
  maxTokens?: number;
  strongTimeoutMs?: number;
  fallbackTimeoutMs?: number;
  /** Called when the call fails over to FALLBACK (pipeline emits an event). */
  onFallback?: (info: { from: string; to: string; reason: string }) => void;
}

/** Plan §5 defaults. */
export const STRONG_TIMEOUT_MS = 45_000;
export const FALLBACK_TIMEOUT_MS = 30_000;
export const STRONG_MAX_TOKENS = 2000;

type ValidationOutcome<T> = { ok: true; data: T } | { ok: false; detail: string };

function validateAgainstSchema<T>(raw: string, schema: z.ZodType<T>): ValidationOutcome<T> {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch (error) {
    return { ok: false, detail: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const details = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, detail: `schema validation failed: ${details}` };
}

/**
 * Calls one model and validates its JSON output against the zod schema.
 * On a parse or zod failure the SAME model is retried once with the
 * validation error fed back (plan §8.3); a timeout or transport error is
 * never retried here — it propagates immediately so callStrong can fail
 * over. If the retry also fails validation, throws ModelCallError; the
 * caller degrades deterministically (extraction -> no claims, verification
 * -> UNVERIFIED "model output unparseable").
 */
export async function callJson<T>(
  options: CallJsonOptions,
  schema: z.ZodType<T>,
): Promise<CallJsonResult<T>> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  // Loop-local: verification runs 4 concurrent calls, so no shared state.
  let detail = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    // First attempt uses the original prompt; the retry appends the zod error.
    const userMessage = attempt === 1 ? options.user : retryPrompt(options.user, detail);
    const result = await converse({ ...options, user: userMessage });
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    const outcome = validateAgainstSchema(result.text, schema);
    if (outcome.ok) {
      return {
        data: outcome.data,
        modelUsed: options.modelId,
        latencyMs: Date.now() - started,
        tokens: { inputTokens, outputTokens },
        attempts: attempt,
      };
    }
    detail = outcome.detail;
    if (attempt === 2) {
      throw new ModelCallError(
        `Model output unparseable after retry (${options.modelId})`,
        options.modelId,
        outcome.detail,
      );
    }
  }
  throw new ModelCallError("unreachable", options.modelId, "loop exhausted");
}

function retryPrompt(original: string, detail: string): string {
  return (
    `${original}\n\nYour previous output failed validation: ${detail}. ` +
    "Return corrected JSON only."
  );
}

/**
 * True when a conversational model error justifies failing over from STRONG
 * to FALLBACK (plan correction 1): a typed timeout, or throttling/5xx that
 * the SDK already retried at least 3 times on the same model. Parse and
 * zod failures (ModelCallError) are deliberately NOT recoverable — parse
 * failures never switch models.
 */
function isFailoverError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof ModelCallError) return false;
  if (!(error instanceof Error)) return false;
  if (error.name.includes("Throttl")) return true;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (typeof metadata?.httpStatusCode === "number" && metadata.httpStatusCode >= 500) return true;
  return (
    error.name === "ServiceUnavailableException" ||
    error.name === "InternalServerException" ||
    error.name === "InternalFailureException"
  );
}

function failoverReason(error: unknown): string {
  if (error instanceof TimeoutError) {
    return `timed out after ${error.timedOutAfterMs}ms`;
  }
  if (error instanceof Error) {
    const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const status = metadata?.httpStatusCode;
    return `error after SDK retries: ${error.name}${status ? ` (HTTP ${status})` : ""}`;
  }
  return String(error);
}

/**
 * STRONG call with the full fallback policy: 45 s timeout, temperature
 * omitted (Kimi K3 rejects it); on timeout or throttling/5xx that survived
 * the SDK's same-model retries, fails over straight to FALLBACK with a 30 s
 * timeout (no extra same-model attempts for transport errors). If FALLBACK
 * also fails, the error propagates and the caller degrades the claim to
 * UNVERIFIED.
 *
 * Parse/zod failures from the STRONG model are NOT failed over — they retry
 * once on the same model inside callJson, then surface as ModelCallError.
 */
export async function callStrong<T>(
  options: CallStrongOptions,
  schema: z.ZodType<T>,
): Promise<CallStrongResult<T>> {
  const started = Date.now();
  try {
    const result = await callJson(
      {
        modelId: options.strongModelId,
        system: options.system,
        user: options.user,
        maxTokens: options.maxTokens ?? STRONG_MAX_TOKENS,
        // No temperature: Kimi K3 rejects the field.
        timeoutMs: options.strongTimeoutMs ?? STRONG_TIMEOUT_MS,
      },
      schema,
    );
    return { ...result, fallbackUsed: false };
  } catch (error) {
    if (!isFailoverError(error)) {
      throw error;
    }
    const reason = failoverReason(error);
    options.onFallback?.({
      from: options.strongModelId,
      to: options.fallbackModelId,
      reason,
    });
    const result = await callJson(
      {
        modelId: options.fallbackModelId,
        system: options.system,
        user: options.user,
        maxTokens: 1000,
        temperature: 0,
        timeoutMs: options.fallbackTimeoutMs ?? FALLBACK_TIMEOUT_MS,
      },
      schema,
    );
    return {
      ...result,
      latencyMs: Date.now() - started,
      fallbackUsed: true,
      fallbackReason: reason,
    };
  }
}
