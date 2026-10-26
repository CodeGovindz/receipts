/**
 * Claim verification: each claim gets one STRONG-model call (with the
 * callStrong fallback policy — plan §5), followed by the guards
 * (guard.ts). Claims run at concurrency 4, results keep claim order.
 *
 * Every failure mode degrades deterministically instead of crashing the
 * run: timeout after fallback -> UNVERIFIED; unparseable output after the
 * same-model retry -> UNVERIFIED "model output unparseable"; any other
 * model error -> UNVERIFIED with the error noted.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { selectHunksForClaim } from "./diff";
import { applyGuards } from "./guard";
import { callStrong, type CallStrongResult, type TokenUsage } from "./llm";
import { buildVerificationPrompt } from "./prompts";
import type { Claim, ClaimResult, PrBundle, VerificationResponse } from "./types";
import { VerificationResponseSchema } from "./types";
import type { Signals } from "./signals";

export const VERIFICATION_CONCURRENCY = 4;

export interface VerifyClaimOptions {
  strongModelId: string;
  fallbackModelId: string;
}

export interface VerifyClaimsOptions extends VerifyClaimOptions {
  /** Emitted when a claim starts verifying (1-based index). */
  onClaimStart?: (info: { index: number; total: number; claim: Claim }) => void;
  /** Emitted when a STRONG call fails over to FALLBACK. */
  onFallback?: (info: { index: number; total: number; from: string; to: string; reason: string }) => void;
  concurrency?: number;
}

export interface VerifyClaimsResult {
  results: ClaimResult[];
  tokens: TokenUsage;
  attempts: number;
  /** Claims whose verdict came from the FALLBACK model. */
  fallbackCount: number;
  unverifiedDueToModelError: number;
}

interface ClaimCallOutcome {
  response: VerificationResponse;
  modelUsed: string;
  latencyMs: number;
  tokens: TokenUsage;
  attempts: number;
  fallbackUsed: boolean;
}

/** One claim through the STRONG model + guards; never throws. */
export async function verifyClaim(
  claim: Claim,
  bundle: PrBundle,
  signals: Signals,
  options: VerifyClaimOptions,
  onFallback?: (info: { from: string; to: string; reason: string }) => void,
): Promise<ClaimResult & { fallbackUsed: boolean; tokens: TokenUsage; attempts: number }> {
  const hunks = selectHunksForClaim(claim, bundle);
  const { system, user } = buildVerificationPrompt(claim, hunks, signals, bundle);

  let outcome: ClaimCallOutcome | null = null;
  let failure: string | null = null;
  try {
    const call: CallStrongResult<VerificationResponse> = await callStrong(
      {
        strongModelId: options.strongModelId,
        fallbackModelId: options.fallbackModelId,
        system,
        user,
        onFallback,
      },
      VerificationResponseSchema,
    );
    outcome = {
      response: call.data,
      modelUsed: call.modelUsed,
      latencyMs: call.latencyMs,
      tokens: call.tokens,
      attempts: call.attempts,
      fallbackUsed: call.fallbackUsed,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      failure = "Verification timed out (STRONG and FALLBACK).";
    } else if (error instanceof Error && error.name === "ModelCallError") {
      failure = "Model output unparseable.";
    } else {
      const message = error instanceof Error ? error.message : String(error);
      failure = `Verification call failed: ${message}`;
    }
  }

  if (outcome === null) {
    const message = failure ?? "Verification failed.";
    return {
      claim,
      verdict: "UNVERIFIED",
      confidence: 0,
      reasoning: message,
      evidence: [],
      modelUsed: "none",
      latencyMs: 0,
      fallbackUsed: false,
      tokens: { inputTokens: 0, outputTokens: 0 },
      attempts: 0,
    };
  }

  const guarded = applyGuards(claim, outcome.response, bundle, signals);
  return {
    claim,
    verdict: guarded.verdict,
    confidence: guarded.confidence,
    reasoning: guarded.reasoning,
    evidence: guarded.evidence,
    modelUsed: outcome.modelUsed,
    latencyMs: outcome.latencyMs,
    fallbackUsed: outcome.fallbackUsed,
    tokens: outcome.tokens,
    attempts: outcome.attempts,
  };
}

/**
 * Verifies all claims at concurrency 4 (default), preserving claim order in
 * the results. Aggregates token usage, attempt count, and how many verdicts
 * came via the FALLBACK model (for the report footer).
 */
export async function verifyClaims(
  claims: Claim[],
  bundle: PrBundle,
  signals: Signals,
  options: VerifyClaimsOptions,
): Promise<VerifyClaimsResult> {
  const total = claims.length;
  const concurrency = options.concurrency ?? VERIFICATION_CONCURRENCY;
  const results: Array<ClaimResult & { fallbackUsed: boolean; tokens: TokenUsage; attempts: number }> =
    new Array(claims.length);

  let nextIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let attempts = 0;
  let fallbackCount = 0;
  let modelErrorCount = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < total) {
      const index = nextIndex++;
      const claim = claims[index];
      options.onClaimStart?.({ index: index + 1, total, claim });
      const result = await verifyClaim(claim, bundle, signals, options, (fallbackInfo) => {
        options.onFallback?.({
          index: index + 1,
          total,
          from: fallbackInfo.from,
          to: fallbackInfo.to,
          reason: fallbackInfo.reason,
        });
      });
      inputTokens += result.tokens.inputTokens;
      outputTokens += result.tokens.outputTokens;
      attempts += result.attempts;
      if (result.fallbackUsed) fallbackCount++;
      if (result.modelUsed === "none") modelErrorCount++;
      results[index] = result;
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(claims.length, 1)) },
    () => worker(),
  );
  await Promise.all(workers);

  return {
    results,
    tokens: { inputTokens, outputTokens },
    attempts,
    fallbackCount,
    unverifiedDueToModelError: modelErrorCount,
  };
}
