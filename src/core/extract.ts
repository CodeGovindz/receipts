/**
 * Claim extraction: one FAST-model call, then the quote guard
 * (plan correction 2): a claim survives only if its `quote` really appears
 * in the source it claims to come from (whitespace-normalized,
 * case-insensitive). Dropped claims are counted in the report — a model
 * that paraphrases "verbatim" quotes cannot inject nonexistent claims.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { callJson, type TokenUsage } from "./llm";
import { sanitizePrBody } from "./github";
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt } from "./prompts";
import type { Claim, PrBundle } from "./types";
import { ExtractionResponseSchema } from "./types";

export const MAX_CLAIMS = 12;
export const FAST_TIMEOUT_MS = 45_000;

export interface ExtractionResult {
  claims: Claim[];
  /** Claims dropped by the quote guard. */
  droppedClaims: number;
  modelUsed: string;
  latencyMs: number;
  tokens: TokenUsage;
  attempts: number;
  /** Set when the FAST call failed and extraction degraded to no claims. */
  error: string | null;
}

/** Collapses all whitespace to single spaces, lowercases. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Where a claim's quote must appear, based on its declared source (sanitized, Bug 4). */
function sourceTextsFor(bundle: PrBundle, source: Claim["source"]): string[] {
  switch (source) {
    case "title":
      return [bundle.title];
    case "pr_body":
      // The fetch layer already sanitizes, but apply again so bundles built
      // any other way (fixtures, tests) get the same treatment.
      return [sanitizePrBody(bundle.body) ?? ""];
    case "commit":
      return bundle.commits.map((commit) => commit.message);
  }
}

/**
 * The quote guard: true when the claim's quote (whitespace-normalized,
 * case-insensitive) is a substring of the text of its declared source.
 */
export function quoteMatchesSource(claim: Claim, bundle: PrBundle): boolean {
  const quote = normalizeText(claim.quote);
  if (quote === "") return false;
  return sourceTextsFor(bundle, claim.source).some(
    (sourceText) => normalizeText(sourceText).includes(quote),
  );
}

/**
 * Extracts up to MAX_CLAIMS checkable claims from the PR text with the FAST
 * model, then drops any claim whose quote the guard cannot find. If the
 * FAST call fails (parse failure after retry, timeout, or API error), the
 * result degrades deterministically to zero claims with `error` set — the
 * run still produces a (MIXED) report instead of crashing.
 */
export async function extractClaims(
  bundle: PrBundle,
  options: { fastModelId: string },
): Promise<ExtractionResult> {
  const prompt = buildExtractionUserPrompt(bundle);
  try {
    const call = await callJson(
      {
        modelId: options.fastModelId,
        system: EXTRACTION_SYSTEM_PROMPT,
        user: prompt,
        maxTokens: 1000,
        temperature: 0,
        timeoutMs: FAST_TIMEOUT_MS,
      },
      ExtractionResponseSchema,
    );

    const seenTexts = new Set<string>();
    const survived: Claim[] = [];
    let droppedClaims = 0;
    for (const claim of call.data.claims.slice(0, MAX_CLAIMS)) {
      // Backstop dedupe of near-identical restatements.
      const dedupeKey = normalizeText(claim.text);
      if (seenTexts.has(dedupeKey)) {
        droppedClaims++;
        continue;
      }
      seenTexts.add(dedupeKey);
      if (quoteMatchesSource(claim, bundle)) {
        survived.push(claim);
      } else {
        droppedClaims++;
      }
    }

    return {
      claims: survived,
      droppedClaims,
      modelUsed: call.modelUsed,
      latencyMs: call.latencyMs,
      tokens: call.tokens,
      attempts: call.attempts,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      claims: [],
      droppedClaims: 0,
      modelUsed: options.fastModelId,
      latencyMs: 0,
      tokens: { inputTokens: 0, outputTokens: 0 },
      attempts: 0,
      error: `Claim extraction failed: ${message}. Treating the PR as having no checkable claims.`,
    };
  }
}
