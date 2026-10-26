/**
 * Zod schemas + inferred types for the whole engine.
 *
 * Everything that crosses a model boundary (extraction, verification) or a
 * process boundary (fixtures, CLI --json, the P2 API) is validated with these
 * schemas, so claims about data shape are checked at runtime, not assumed.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const VerdictSchema = z.enum(["VERIFIED", "CONTRADICTED", "UNVERIFIED"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ClaimSourceSchema = z.enum(["title", "pr_body", "commit"]);
export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

export const ClaimCategorySchema = z.enum([
  "tests_added",
  "tests_pass",
  "bug_fixed",
  "feature_added",
  "no_breaking_change",
  "refactor_only",
  "docs_updated",
  "dependency_change",
  "performance",
  "security",
  "other",
]);
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>;

export const GradeSchema = z.enum(["PASS", "MIXED", "FAIL"]);
export type Grade = z.infer<typeof GradeSchema>;

// ---------------------------------------------------------------------------
// Diff / changed files
// ---------------------------------------------------------------------------

/** New-file line range of one hunk, parsed from the `@@ -a,b +c,d @@` header. */
export const HunkSchema = z.object({
  newStart: z.number().int(),
  newLines: z.number().int(),
});
export type Hunk = z.infer<typeof HunkSchema>;

/**
 * A changed file in the PR. GitHub's metadata plus the values diff.ts
 * derives from the patch: hunk ranges, budget flags, and the test heuristic.
 */
export const ChangedFileSchema = z.object({
  path: z.string(),
  /** For renames: the path the file had before this PR. */
  previousPath: z.string().nullable(),
  /** GitHub's status: added | removed | modified | renamed | changed | unchanged. */
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Unified diff; null for binaries or when skipped/truncated to nothing. */
  patch: z.string().nullable(),
  /** New-file line ranges for every hunk (all hunks, even past the patch cap). */
  hunks: z.array(HunkSchema),
  /** True when the stored patch was capped at the 400-line per-file budget. */
  patchTruncated: z.boolean(),
  /** True for lockfiles/dist/minified/binary/images/snapshots (patch dropped). */
  excluded: z.boolean(),
  /** Result of the isTestFile() heuristic. */
  isTest: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

// ---------------------------------------------------------------------------
// GitHub bundle
// ---------------------------------------------------------------------------

export const CheckRunSchema = z.object({
  name: z.string(),
  /** queued | in_progress | completed. */
  status: z.string(),
  /** success | failure | neutral | cancelled | timed_out | skipped | null. */
  conclusion: z.string().nullable(),
  /** Link to the check run detail page (evidence URL). */
  htmlUrl: z.string(),
  /** First failure annotation of a failed run, e.g. "Unexpected HTTP response: 504". */
  failureMessage: z.string().nullable().optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const StatusEntrySchema = z.object({
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullable(),
  /** Status description, e.g. Vercel's "Authorization required to deploy." */
  description: z.string().nullable().optional(),
});
export type StatusEntry = z.infer<typeof StatusEntrySchema>;

export const CombinedStatusSchema = z.object({
  /** success | failure | pending | error | null. */
  state: z.string().nullable(),
  /** Legacy commit statuses (some repos use these instead of check runs). */
  statuses: z.array(StatusEntrySchema),
});
export type CombinedStatus = z.infer<typeof CombinedStatusSchema>;

export const CommitInfoSchema = z.object({
  sha: z.string(),
  /** First line of the commit message. */
  message: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

/**
 * Everything the engine knows about a PR: text, diff, commits, and CI state
 * for the head SHA. Fixtures persist this shape (fixtures/*.json).
 */
export const PrBundleSchema = z.object({
  /** Canonical html URL of the pull request. */
  prUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  author: z.string(),
  headSha: z.string(),
  files: z.array(ChangedFileSchema),
  commits: z.array(CommitInfoSchema),
  checkRuns: z.array(CheckRunSchema),
  combinedStatus: CombinedStatusSchema.nullable(),
  fetchedAt: z.string(),
  /** True when the file list was capped at 100 files. */
  filesTruncated: z.boolean(),
  /** True when the commit list was capped at 50 commits. */
  commitsTruncated: z.boolean(),
});
export type PrBundle = z.infer<typeof PrBundleSchema>;

// ---------------------------------------------------------------------------
// Claims (model I/O)
// ---------------------------------------------------------------------------

export const ClaimScopeSchema = z.enum(["ci", "local", "unspecified"]);
export type ClaimScope = z.infer<typeof ClaimScopeSchema>;

export const ClaimSchema = z.object({
  /** Re-stated claim text, self-contained and understandable without the PR. */
  text: z.string().min(1),
  /** Verbatim quote from the claim's source; checked by the quote guard. */
  quote: z.string(),
  source: ClaimSourceSchema,
  category: ClaimCategorySchema,
  /**
   * What the claim is about, so tests_pass logic can treat "tests pass
   * locally" differently from "CI is green": `ci` = a statement about CI /
   * observable PR state; `local` = a statement about runs on the author's
   * machine; `unspecified` = everything else.
   */
  scope: ClaimScopeSchema.default("unspecified"),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ExtractionResponseSchema = z.object({
  claims: z.array(ClaimSchema),
});
export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

/**
 * One evidence item as the model returns it. `path` = changed-file path,
 * `line` = 1-based new-file line, `checkRunName` = CI check, `detail` =
 * human note or, for type "signal", the signal's stable key. Nullish: the
 * model may omit keys per entry (the guards narrow what they use).
 */
export const EvidenceItemSchema = z.object({
  type: z.enum(["file", "check_run", "signal"]),
  path: z.string().nullish(),
  line: z.number().nullish(),
  checkRunName: z.string().nullish(),
  detail: z.string().nullish(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const VerificationResponseSchema = z.object({
  verdict: VerdictSchema,
  // Coerced: models occasionally emit "0.8" as a string.
  confidence: z.coerce.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(EvidenceItemSchema).max(20).default([]),
});
export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

/**
 * One evidence item inside a ClaimResult: the model's output after the
 * guards validated/cleaned it — with a resolvable URL when one exists.
 */
export const ClaimEvidenceSchema = z.object({
  type: z.enum(["file", "check_run", "signal"]),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  checkRunName: z.string().nullable(),
  detail: z.string().nullable(),
  /** blob URL at headSha (with #L when the line survived the line guard) or check-run URL. */
  url: z.string().nullable(),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

/** Final per-claim record: the model's verdict after the guards had their say. */
export const ClaimResultSchema = z.object({
  claim: ClaimSchema,
  verdict: VerdictSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(ClaimEvidenceSchema),
  /** Bedrock model ID that produced this verdict (may be the FALLBACK model). */
  modelUsed: z.string(),
  latencyMs: z.number().int().nonnegative(),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const ReportTimingsSchema = z.object({
  fetchMs: z.number().int().nonnegative(),
  extractMs: z.number().int().nonnegative(),
  verifyMs: z.number().int().nonnegative(),
  totalMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  llmCalls: z.number().int().nonnegative(),
  /** Model attempts (incl. same-model retries) for the extraction call. */
  extractAttempts: z.number().int().nonnegative(),
  /** Sum of model attempts across all claim verifications. */
  verifyAttempts: z.number().int().nonnegative(),
});
export type ReportTimings = z.infer<typeof ReportTimingsSchema>;

export const ModelsUsedSchema = z.object({
  /** Model that extracted the claims (FAST). */
  claimsModel: z.string().nullable(),
  /** Distinct Bedrock model IDs that produced verdicts, in order of first use. */
  verdictsModels: z.array(z.string()),
  /** How many verdicts came via the FALLBACK model. */
  fallbackCount: z.number().int().nonnegative(),
  /** The FALLBACK model ID, when it fired at least once. */
  fallbackModel: z.string().nullable(),
});
export type ModelsUsed = z.infer<typeof ModelsUsedSchema>;

/**
 * The final Receipts report. `trustScore` = verified / total claims; null
 * when there were no claims (rendered as "—").
 */
export const ReportSchema = z.object({
  grade: GradeSchema,
  trustScore: z.number().nullable(),
  claims: z.array(ClaimResultSchema),
  /** Claims dropped by the quote guard (quote not found in source). */
  droppedClaims: z.number().int().nonnegative(),
  /** Human-readable deterministic signal summary, e.g. "3 test files changed". */
  signals: z.array(z.string()),
  modelsUsed: ModelsUsedSchema,
  timings: ReportTimingsSchema,
  headSha: z.string(),
  prUrl: z.string(),
  /** True when served from the in-memory report cache. */
  cached: z.boolean(),
});
export type Report = z.infer<typeof ReportSchema>;
