/**
 * Unified-diff processing: hunk-header parsing into new-file line ranges,
 * noise skip-lists, size budgets, the test-file heuristic, and per-claim
 * hunk selection. Feeds the line guard (guard.ts), signals (signals.ts),
 * and the verification prompt (prompts.ts).
 *
 * This module must stay framework-free: no Next.js imports.
 */
import type { ChangedFile, Claim, Hunk, PrBundle } from "./types";

/** Per-patch budget: at most this many unified-diff lines are stored (docs/PLAN.md §3). */
export const MAX_PATCH_LINES = 400;
/** Total budget across all stored patches in one bundle. */
export const TOTAL_PATCH_CHAR_BUDGET = 60_000;
/** Default context budget for one claim's selected hunks. */
export const DEFAULT_CLAIM_BUDGET_CHARS = 12_000;

/** Raw file shape handed in by github.ts, before enrichment. */
export interface ChangedFileInput {
  path: string;
  previousPath: string | null | undefined;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Hunk headers
// ---------------------------------------------------------------------------

/**
 * Parses `@@ -a,b +c,d @@` headers into new-file line ranges
 * ({@link Hunk}). Omitted counts mean 1 (e.g. `@@ -5 +5 @@`).
 * New files: `@@ -0,0 +1,N @@`; deletions: `@@ -a,b +0,0 @@`
 * (empty new-file range, so the line guard drops any cited line there).
 */
export function parseHunkRanges(patch: string): Hunk[] {
  const ranges: Hunk[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("@@")) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      ranges.push({
        newStart: Number.parseInt(match[1], 10),
        newLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
      });
    }
  }
  return ranges;
}

/** A hunk block: full text (namespace `@@` header included) + new-file span. */
export interface PatchHunkBlock {
  content: string;
  startLine: number;
  endLine: number;
}

/** Splits a patch into hunk blocks; diff metadata lines (diff --git, index, ---, +++) are dropped. */
export function splitPatchHunks(patch: string): PatchHunkBlock[] {
  const hunks: PatchHunkBlock[] = [];
  let currentLines: string[] | null = null;
  const flush = (): void => {
    if (currentLines && currentLines.length > 0) {
      const header = currentLines[0];
      const match = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      const newStart = match ? Number.parseInt(match[1], 10) : 0;
      const newLines = match ? (match[2] === undefined ? 1 : Number.parseInt(match[2], 10)) : 0;
      hunks.push({
        content: currentLines.join("\n"),
        startLine: newStart,
        endLine: newLines > 0 ? newStart + newLines - 1 : -1,
      });
    }
    currentLines = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      currentLines = [line];
    } else if (currentLines !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return hunks;
}

/** One line of a patch, with its resolved line number. */
export interface PatchLine {
  kind: "add" | "del" | "context";
  /** New-file line number for add/context; old-file line number for del. */
  line: number;
  /** Line content without the +/-/space marker. */
  text: string;
}

/**
 * Walks a patch line by line, resolving new-file (add/context) and old-file
 * (del) line numbers. `\ No newline at end of file` markers are ignored.
 */
export function eachPatchLine(patch: string, visit: (entry: PatchLine) => void): void {
  let newLine = 0;
  let oldLine = 0;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      oldLine = match ? Number.parseInt(match[1], 10) : 0;
      newLine = match ? Number.parseInt(match[3], 10) : 0;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      visit({ kind: "add", line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith("-")) {
      visit({ kind: "del", line: oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith(" ")) {
      visit({ kind: "context", line: newLine, text: line.slice(1) });
      newLine++;
      oldLine++;
    } else if (line === "" && (newLine > 0 || oldLine > 0)) {
      // Blank context line inside a hunk (the patch stores it as an empty line).
      visit({ kind: "context", line: newLine, text: "" });
      newLine++;
      oldLine++;
    }
  }
}

// ---------------------------------------------------------------------------
// Skip-lists / heuristics
// ---------------------------------------------------------------------------

const LOCKFILE_PATTERN =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-lock\.json|bun\.lockb|bun\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|deno\.lock|flake\.lock|packages\.lock\.json)$/i;

const VENDORED_DIR_PATTERN =
  /(^|\/)(node_modules|vendor|vendors|third_party|3rd[_-]?party|dist|build|out|coverage|\.next|\.turbo|target|\.venv|venv|\.tox|__pycache__)\//i;

const MINIFIED_PATTERN = /(^|[.-])(min|minified|bundle|chunk)([.-][a-z0-9]+)*\.(js|mjs|cjs|css)$/i;

const BINARY_ASSET_PATTERN =
  /\.(png|jpe?g|gif|webp|bmp|tiff?|svgz?|ico|avif|woff2?|ttf|otf|eot|mp3|mp4|webm|mov|avi|mkv|pdf|zip|tar|gz|tgz|bz2|7z|rar|exe|dll|so|dylib|jar|class|wasm|pyc|pyo|node|bin|dat|pack|idx|psd|sketch|cdr)$/i;

const SNAPSHOT_PATTERN = /(^|\/)__snapshots__\/|\.snap$|\.snapshot$/i;

/** True for files whose diffs are pure noise for claim verification. */
export function isSkippablePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    LOCKFILE_PATTERN.test(normalized) ||
    VENDORED_DIR_PATTERN.test(normalized) ||
    MINIFIED_PATTERN.test(normalized) ||
    BINARY_ASSET_PATTERN.test(normalized) ||
    SNAPSHOT_PATTERN.test(normalized)
  );
}

/** Test-file heuristic covering the common conventions across languages. */
export function isTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (/(^|\/)(__tests__|__specs__|tests?|spec|specs|e2e|cypress|playwright)\//i.test(normalized)) {
    return true;
  }
  if (/\.(test|spec|e2e-spec|integration|bench)\.[a-z0-9]+$/i.test(normalized)) return true;
  if (/_test\.[a-z0-9]+$/i.test(normalized)) return true; // Go, Rust conventions
  if (/(^|\/)(test_|conftest)[a-z0-9_]*\.py$/i.test(normalized)) return true; // pytest
  if (/[a-z0-9]_[tT]est\.py$/i.test(normalized)) return true;
  if (/(^|\/)[A-Za-z0-9]+(Test|Tests|Spec|Suite|IT)\.(java|kt|kts|cs|go|scala|swift)$/i.test(normalized)) {
    return true;
  }
  return false;
}

/** Path is a dependency manifest we track in the dependencyChanges signal. */
export function isDependencyManifest(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    /(^|\/)package\.json$/i.test(normalized) ||
    /(^|\/)requirements[a-z0-9.-]*\.txt$/i.test(normalized) ||
    /(^|\/)pyproject\.toml$/i.test(normalized) ||
    /(^|\/)Pipfile$/i.test(normalized) ||
    /(^|\/)go\.mod$/i.test(normalized) ||
    /(^|\/)Cargo\.toml$/i.test(normalized) ||
    /(^|\/)composer\.json$/i.test(normalized) ||
    /(^|\/)Gemfile$/i.test(normalized) ||
    /(^|\/)pom\.xml$/i.test(normalized)
  );
}

/** Human-facing docs (docsChanged signal + docs_updated category routing). */
export function isDocPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (/\.mdx?$/i.test(normalized)) return true;
  if (/(^|\/)README/i.test(normalized)) return true;
  if (/^(docs?|documentation|man)\//i.test(normalized)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

function truncatePatchLines(patch: string, maxLines: number): { patch: string; truncated: boolean } {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return { patch, truncated: false };
  return {
    patch: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

/** Lower allocation priority number = gets budget first when the total cap bites. */
function allocationPriority(file: ChangedFileInput): number {
  if (isSkippablePath(file.path)) return 9;
  if (isTestFile(file.path)) return 0;
  if (isDependencyManifest(file.path)) return 1;
  if (isDocPath(file.path)) return 3;
  return 2;
}

/**
 * Turns raw GitHub file entries into validated ChangedFiles: parses hunk
 * ranges from the FULL patch (so the line guard sees every range), drops
 * patches for skip-listed files, caps each patch at 400 lines, and enforces
 * the 60k-char total budget (test files and dependency manifests first).
 */
export function enrichChangedFiles(files: ChangedFileInput[]): ChangedFile[] {
  const result: ChangedFile[] = files.map((file) => {
    const skippable = isSkippablePath(file.path);
    let patch: string | null = file.patch ?? null;
    let patchTruncated = false;
    if (skippable || patch === null) {
      patch = null;
    } else {
      const capped = truncatePatchLines(patch, MAX_PATCH_LINES);
      patch = capped.patch;
      patchTruncated = capped.truncated;
    }
    return {
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      // Hunk ranges come from the raw GitHub patch, before any truncation.
      hunks: file.patch ? parseHunkRanges(file.patch) : [],
      patchTruncated,
      excluded: skippable,
      isTest: isTestFile(file.path),
    };
  });

  // Total-budget pass in priority order; array order stays GitHub's.
  let remaining = TOTAL_PATCH_CHAR_BUDGET;
  const order = result
    .map((file, index) => ({ file, index }))
    .sort((a, b) => allocationPriority(a.file) - allocationPriority(b.file));
  for (const { file } of order) {
    if (file.patch === null) continue;
    if (file.patch.length <= remaining) {
      remaining -= file.patch.length;
      continue;
    }
    if (remaining > 500) {
      file.patch = file.patch.slice(0, remaining);
      file.patchTruncated = true;
    } else {
      file.patch = null;
      file.patchTruncated = true;
    }
    remaining = 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-claim hunk selection
// ---------------------------------------------------------------------------

/** A selected hunk ready for the verification prompt. */
export interface SelectedHunk {
  path: string;
  content: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "all", "any", "now", "was", "were",
  "are", "his", "her", "its", "be", "been", "has", "have", "had", "not", "but", "can", "will",
  "shall", "should", "would", "could", "into", "onto", "over", "under", "out", "use", "used",
  "uses", "using", "new", "add", "added", "adds", "fix", "fixed", "fixes", "make", "made",
  "makes", "support", "supported", "supports", "change", "changed", "changes", "update",
  "updated", "updates", "remove", "removed", "removes", "improve", "improved", "improves",
  "include", "included", "includes", "also", "more", "when", "then", "than", "some", "which",
  "where", "without", "only", "very", "just", "tests", "test",
]);

/** Meaningful lowercase tokens from the claim text + quote. */
export function claimTokens(claim: Pick<Claim, "text" | "quote">): Set<string> {
  const words = `${claim.text} ${claim.quote}`
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  return new Set(words);
}

interface ScoredHunk {
  path: string;
  block: PatchHunkBlock;
  isTest: boolean;
  pathScore: number;
  contentScore: number;
  length: number;
}

/**
 * The one bucket a claim's category prefers to see first, per plan §3:
 * tests_* -> test files; docs_updated -> markdown; dependency_change ->
 * manifests; no_breaking_change -> hunks that delete things.
 */
function preferredBucket(category: Claim["category"]): "test" | "docs" | "deps" | "deletions" | null {
  switch (category) {
    case "tests_added":
    case "tests_pass":
      return "test";
    case "docs_updated":
      return "docs";
    case "dependency_change":
      return "deps";
    case "no_breaking_change":
      return "deletions";
    default:
      return null;
  }
}

type HunkBucket = "test" | "docs" | "deps" | "deletions" | "nontest";

function bucketOf(hunk: ScoredHunk, bundle: Pick<PrBundle, "files">): HunkBucket {
  if (hunk.isTest) return "test";
  if (isDocPath(hunk.path)) return "docs";
  if (isDependencyManifest(hunk.path)) return "deps";
  const file = bundle.files.find((candidate) => candidate.path === hunk.path);
  if ((file?.deletions ?? 0) > 0 && hunk.block.content.includes("\n-")) return "deletions";
  return "nontest";
}

/**
 * Selects the hunks most relevant to one claim within the char budget
 * (default 12k). Scoring is keyword overlap between the claim text and
 * (path, hunk content), with category routing (tests_* -> test files first,
 * docs -> markdown, dependency -> manifests, no_breaking_change ->
 * hunks with deletions). If nothing scores, falls back to the largest
 * non-test hunks — we never send an empty context when the bundle has hunks.
 */
export function selectHunksForClaim(
  claim: Claim,
  bundle: Pick<PrBundle, "files">,
  budgetChars: number = DEFAULT_CLAIM_BUDGET_CHARS,
): SelectedHunk[] {
  const tokens = claimTokens(claim);
  const preferred = preferredBucket(claim.category);
  const scored = scoreHunks(bundle, tokens);

  const hasMatches = scored.some((hunk) => hunk.pathScore > 0 || hunk.contentScore > 0);
  let ordered: ScoredHunk[];
  if (hasMatches) {
    ordered = [...scored].sort((a, b) => {
      if (preferred !== null) {
        const aPreferred = bucketOf(a, bundle) === preferred ? 0 : 1;
        const bPreferred = bucketOf(b, bundle) === preferred ? 0 : 1;
        if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      }
      const totalA = a.pathScore + a.contentScore;
      const totalB = b.pathScore + b.contentScore;
      if (totalA !== totalB) return totalB - totalA;
      return b.length - a.length;
    });
  } else {
    // Fallback: largest non-test hunks within budget, never an empty context.
    ordered = [...scored]
      .filter((hunk) => !hunk.isTest)
      .sort((a, b) => b.length - a.length);
    if (ordered.length === 0) ordered = [...scored].sort((a, b) => b.length - a.length);
  }

  const selected: SelectedHunk[] = [];
  let remaining = budgetChars;
  for (const hunk of ordered) {
    if (remaining <= 0) break;
    if (hunk.length <= remaining) {
      selected.push({ path: hunk.path, content: hunk.block.content });
      remaining -= hunk.length;
    } else if (remaining > 500) {
      selected.push({
        path: hunk.path,
        content: `${hunk.block.content.slice(0, remaining)}\n… (hunk truncated)`,
      });
      remaining = 0;
    }
  }
  return selected;
}

function scoreHunks(bundle: Pick<PrBundle, "files">, tokens: Set<string>): ScoredHunk[] {
  const scored: ScoredHunk[] = [];
  for (const file of bundle.files) {
    if (file.excluded || file.patch === null) continue;
    const pathLower = file.path.toLowerCase();
    let pathScore = 0;
    for (const token of tokens) {
      if (pathLower.includes(token)) pathScore += 3;
    }
    for (const block of splitPatchHunks(file.patch)) {
      const contentLower = block.content.toLowerCase();
      let contentScore = 0;
      for (const token of tokens) {
        if (contentLower.includes(token)) contentScore += 1;
      }
      scored.push({
        path: file.path,
        block,
        isTest: file.isTest,
        pathScore,
        contentScore,
        length: block.content.length,
      });
    }
  }
  return scored;
}
