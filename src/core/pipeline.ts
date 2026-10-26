/**
 * Pipeline orchestration: URL -> bundle -> signals -> extract -> verify
 * (concurrency 4) -> guarded -> report. Emits typed progress events for the
 * CLI's stderr log (and P2's NDJSON stream), and keeps the correction-7
 * in-memory report cache keyed by owner/repo#number@headSha + model IDs.
 *
 * runReceiptsOnBundle() runs everything after the GitHub fetch, so the CLI's
 * --fixture mode and the eval suite can drive a saved PrBundle without any
 * network access (the Bedrock models still run live).
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
  /** Override the environment-derived config (tests/CLI fixture mode). */
  config?: ReceiptsConfig;
  /** Receives the fetched, enriched bundle (CLI `--dump-fixture`). */
  onBundle?: (bundle: PrBundle) => void;
}

export interface RunOnBundleOptions {
  /** No env fallback here: the caller (runReceipts, CLI --fixture, eval) owns the config. */
  config: ReceiptsConfig;
  onEvent?: (event: PipelineEvent) => void;
  fresh?: boolean;
  /** Store the report in the cache (default true; false for draft checks, whose bundle isn't the real PR). */
  cache?: boolean;
  /** Time the GitHub fetch took, for honest timings on live runs (default 0). */
  fetchMs?: number;
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
 * Runs the full pipeline on an already-fetched PrBundle: signals, claim
 * extraction, verification, guards, report. Used by runReceipts() after the
 * GitHub fetch and directly by the CLI's --fixture mode and the eval suite.
 */
export async function runReceiptsOnBundle(
  bundle: PrBundle,
  options: RunOnBundleOptions,
): Promise<Report> {
  const config = options.config;
  const emit = (event: PipelineEvent): void => {
    options.onEvent?.(event);
  };

  const started = Date.now();
  try {
    const key = cacheKey(bundle, config);
    if (!options.fresh) {
      const cached = reportCache.get(key);
      if (cached) {
        emit({
          type: "fetched",
          title: bundle.title,
          filesChanged: bundle.files.length,
          checkRuns: bundle.checkRuns.length,
        });
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
      concurrency: 4,
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
        fetchMs: options.fetchMs ?? 0,
        extractMs,
        verifyMs,
        totalMs: Date.now() - started,
        inputTokens: extraction.tokens.inputTokens + verification.tokens.inputTokens,
        outputTokens: extraction.tokens.outputTokens + verification.tokens.outputTokens,
        llmCalls: extraction.attempts + verification.attempts,
        extractAttempts: extraction.attempts,
        verifyAttempts: verification.attempts,
      },
    });
    if (options.cache !== false) reportCache.set(key, report);
    emit({ type: "done", report });
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", error: message });
    throw error;
  }
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

  const fetchStarted = Date.now();
  try {
    emit({ type: "fetching" });
    const bundle = await fetchPrBundle(prUrl, { githubToken: config.githubToken });
    const fetchMs = Date.now() - fetchStarted;
    options.onBundle?.(bundle);
    const report = await runReceiptsOnBundle(bundle, {
      config,
      onEvent: options.onEvent,
      fresh: options.fresh,
      fetchMs,
    });
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", error: message });
    throw error;
  }
}

/** Max draft claims check_claims accepts in one call. */
export const MAX_DRAFT_CLAIMS = 12;

/**
 * Checks claims an agent is ABOUT to make (e.g. a draft PR description)
 * against the PR's real diff and CI, before it writes them. The drafts
 * replace the PR's own title, body and commits as the extraction source, so
 * the quote guard validates against exactly what the agent submitted.
 * Never cached: the same head SHA answers different drafts.
 */
export async function runClaimCheck(
  prUrl: string,
  claims: string[],
  options: Omit<RunReceiptsOptions, "fresh" | "onBundle"> = {},
): Promise<Report> {
  loadDotEnv();
  const config = options.config ?? getConfig();
  const drafts = claims.map((claim) => claim.trim()).filter((claim) => claim !== "");
  if (drafts.length === 0) throw new Error("Provide at least one claim to check.");
  if (drafts.length > MAX_DRAFT_CLAIMS) {
    throw new Error(`Check at most ${MAX_DRAFT_CLAIMS} claims per call (got ${drafts.length}).`);
  }

  const fetchStarted = Date.now();
  options.onEvent?.({ type: "fetching" });
  const bundle = await fetchPrBundle(prUrl, { githubToken: config.githubToken });
  const draftBundle: PrBundle = {
    ...bundle,
    title: "",
    body: drafts.map((claim) => `- ${claim}`).join("\n"),
    commits: [],
  };
  return runReceiptsOnBundle(draftBundle, {
    config,
    onEvent: options.onEvent,
    fresh: true,
    cache: false,
    fetchMs: Date.now() - fetchStarted,
  });
}
