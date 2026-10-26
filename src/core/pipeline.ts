/**
 * Pipeline orchestration: URL -> bundle -> signals -> extract -> verify
 * (concurrency 4) -> guarded -> report. Emits typed progress events for the
 * CLI's stderr log (and P2's NDJSON stream), and keeps the correction-7
 * in-memory report cache keyed by owner/repo#number@headSha + model IDs.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { getConfig, type ReceiptsConfig, loadDotEnv } from "./env";
import { extractClaims } from "./extract";
import { fetchPrBundle } from "./github";
import { buildReport } from "./report";
import { buildSignalsSummary, computeSignals } from "./signals";
import type { PrBundle, Report } from "./types";
import { verifyClaims } from "./verify";

/** Typed progress events (streamed to the CLI log and, in P2, the API NDJSON). */
export type PipelineEvent =
  | { type: "fetching" }
  | { type: "fetched"; title: string; filesChanged: number; checkRuns: number }
  | { type: "extracting" }
  | { type: "extracted"; total: number; dropped: number; error: string | null }
  | { type: "verifying"; index: number; total: number; claim: string }
  | { type: "fallback"; index: number; total: number; from: string; to: string; reason: string }
  | { type: "done"; report: Report }
  | { type: "error"; error: string };

export interface RunReceiptsOptions {
  onEvent?: (event: PipelineEvent) => void;
  /** Bypass the in-memory report cache (correction 7: `?fresh=1`). */
  fresh?: boolean;
  /** Override the environment-derived config (tests/CLI). */
  config?: ReceiptsConfig;
  /** Receives the fetched, enriched bundle (CLI `--dump-fixture`). */
  onBundle?: (bundle: PrBundle) => void;
}

// In-memory report cache keyed by owner/repo#number@headSha + model IDs.
const reportCache = new Map<string, Report>();

function cacheKey(
  bundle: Pick<PrBundle, "owner" | "repo" | "number" | "headSha">,
  config: ReceiptsConfig,
): string {
  return (
    `${bundle.owner}/${bundle.repo}#${bundle.number}@${bundle.headSha}` +
    `|${config.modelFast}|${config.modelStrong}|${config.modelFallback}`
  );
}

/** Test support: clears the in-memory report cache. */
export function clearReportCache(): void {
  reportCache.clear();
}

/**
 * Runs Receipts end-to-end on one public GitHub PR and resolves with the
 * final report. Progress events flow to `onEvent`; failures emit an `error`
 * event and rethrow. On error the pipeline never resolves — callers (CLI,
 * P2 API) surface the failure themselves.
 */
export async function runReceipts(prUrl: string, options: RunReceiptsOptions = {}): Promise<Report> {
  // Entry-point convenience: callers that did not loadDotEnv themselves still
  // work; loadDotEnv never overrides real environment variables.
  loadDotEnv();
  const config = options.config ?? getConfig();
  const emit = (event: PipelineEvent): void => {
    options.onEvent?.(event);
  };

  const started = Date.now();
  try {
    emit({ type: "fetching" });
    const fetchStarted = Date.now();
    const bundle = await fetchPrBundle(prUrl, { githubToken: config.githubToken });
    const fetchMs = Date.now() - fetchStarted;
    options.onBundle?.(bundle);

    const key = cacheKey(bundle, config);
    if (!options.fresh) {
      const cached = reportCache.get(key);
      if (cached) {
        emit({ type: "done", report: cached });
        return cached;
      }
    }

    emit({
      type: "fetched",
      title: bundle.title,
      filesChanged: bundle.files.length,
      checkRuns: bundle.checkRuns.length,
    });

    const signals = computeSignals(bundle);

    emit({ type: "extracting" });
    const extractStarted = Date.now();
    const extraction = await extractClaims(bundle, { fastModelId: config.modelFast });
    const extractMs = Date.now() - extractStarted;
    emit({
      type: "extracted",
      total: extraction.claims.length,
      dropped: extraction.droppedClaims,
      error: extraction.error,
    });

    const verifyStarted = Date.now();
    const verification = await verifyClaims(extraction.claims, bundle, signals, {
      strongModelId: config.modelStrong,
      fallbackModelId: config.modelFallback,
      onClaimStart: ({ index, total, claim }) => {
        emit({ type: "verifying", index, total, claim: claim.text });
      },
      onFallback: ({ index, total, from, to, reason }) => {
        emit({ type: "fallback", index, total, from, to, reason });
      },
    });
    const verifyMs = Date.now() - verifyStarted;

    const report = buildReport({
      prUrl: bundle.prUrl,
      headSha: bundle.headSha,
      results: verification.results,
      droppedClaims: extraction.droppedClaims,
      signalsSummary: buildSignalsSummary(signals),
      claimsModel: extraction.error === null ? extraction.modelUsed : null,
      fallbackModel: config.modelFallback,
      fallbackCount: verification.fallbackCount,
      timings: {
        fetchMs,
        extractMs,
        verifyMs,
        totalMs: Date.now() - started,
        inputTokens: extraction.tokens.inputTokens + verification.tokens.inputTokens,
        outputTokens: extraction.tokens.outputTokens + verification.tokens.outputTokens,
        llmCalls: extraction.attempts + verification.attempts,
      },
    });
    reportCache.set(key, report);
    emit({ type: "done", report });
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", error: message });
    throw error;
  }
}
