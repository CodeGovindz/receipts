/**
 * Deterministic signals computed once per PR — no LLM involved
 * (docs/PLAN.md §6, corrections 4 and 5).
 *
 * Every signal has a STABLE KEY: guard.ts uses the key to decide whether a
 * `signal` evidence item actually exists before accepting it.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { eachPatchLine, isDependencyManifest, isDocPath, type PatchLine } from "./diff";
import type { PrBundle } from "./types";

/** One removed public API symbol (REMOVAL — see plan correction 4). */
export interface RemovedExport {
  symbol: string;
  path: string;
  kind: "function" | "class" | "type" | "interface" | "enum" | "variable" | "method" | "file";
}

/** A symbol whose name was removed and re-added (SIGNATURE_CHANGE — correction 4). */
export interface SignatureChange {
  symbol: string;
  /** Where the symbol was removed. */
  path: string;
  /** Where the same name was added again (may be a different file). */
  readdedIn: string;
}

/** Markers for skipped/focused tests, with file + new-file line (plan §6). */
export interface SkippedOrFocusedTest {
  file: string;
  line: number;
  marker: string;
}

/** Dependency file change, with major version bumps flagged (plan §6). */
export interface DependencyChange {
  path: string;
  /** Number of distinct dependencies updated in this file. */
  updatedCount: number;
  /** e.g. ["express 4→5"]. */
  majorBumps: string[];
}

/** What a CI check actually does — drives which claims it can confirm or refute. */
export type CheckKind = "test" | "lint" | "typecheck" | "build" | "deploy" | "bot" | "other";

/**
 * Classifies a check-run/legacy-status name into a kind by name regex.
 * Order matters: "test" wins over "build" so "build and test" counts as test;
 * "bot" wins over "deploy" so "Vercel Agent Review" counts as bot.
 */
const KIND_PATTERNS: Array<{ kind: CheckKind; pattern: RegExp }> = [
  {
    kind: "test",
    pattern: /\b(tests?|testing|spec|jest|vitest|pytest|mocha|e2e|unit|integration|playwright|cypress|ctest)\b/i,
  },
  { kind: "lint", pattern: /lint|format|fmt|biome|eslint|prettier|clippy|style|ruff/i },
  { kind: "typecheck", pattern: /type.?check|tsc\b|mypy|pyright/i },
  { kind: "build", pattern: /\bbuild|compile/i },
  {
    kind: "bot",
    pattern:
      /greptile|coderabbit|socket|security|review|trust|label|scope|plan|detect|codecov|sonar|agent|bot\b|copilot|greptile/i,
  },
  { kind: "deploy", pattern: /vercel|netlify|deploy|preview|pages|render|railway|fly\.io|heroku/i },
];

export function classifyCheckName(name: string): CheckKind {
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(name)) return kind;
  }
  return "other";
}

/**
 * Which CI kinds a piece of claim text explicitly talks about — e.g. the
 * claim "Biome format checks pass" hints "lint"; "all tests pass" hints
 * "test". The guard uses this so a claim is only refuted (or confirmed) by
 * checks of the kind it actually makes a statement about.
 */
export function claimCheckKindHints(text: string): CheckKind[] {
  return KIND_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}

/** What one check effectively tells us, after ignoring non-outcomes. */
export type CheckEffect = "success" | "failure" | "pending" | "ignored";

/** Conclusion/status combinations that neither pass nor fail (Bug 3 treatment). */
const IGNORABLE_CONCLUSIONS = new Set(["skipped", "neutral", "stale"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);
const PENDING_STATUSES = new Set(["queued", "in_progress"]);

export function effectiveCheckEffect(status: string, conclusion: string | null): CheckEffect {
  if (conclusion !== null) {
    if (IGNORABLE_CONCLUSIONS.has(conclusion)) return "ignored";
    if (conclusion === "success") return "success";
    if (FAILURE_CONCLUSIONS.has(conclusion)) return "failure";
  }
  if (PENDING_STATUSES.has(status)) return "pending";
  if (conclusion === null && (status === "completed" || status === "")) return "ignored";
  return "pending";
}

/** One CI observation (check run or legacy status) as the verify prompt and guard see it. */
export interface CiObservation {
  name: string;
  status: string;
  /** Raw GitHub conclusion (check runs) or state (legacy statuses); may be null. */
  conclusion: string | null;
  htmlUrl: string;
  kind: CheckKind;
  effective: CheckEffect;
}

export interface CiSignal {
  /** True when nothing CI-shaped exists at the head SHA, or every check was skipped/neutral (nothing executed). */
  none: boolean;
  /** Outcome roll-up: "none" | "pending" | "success" | "failure". */
  outcome: "none" | "pending" | "success" | "failure";
  pending: boolean;
  /** Check runs + legacy statuses, each classified by kind and effective outcome. */
  checkRuns: CiObservation[];
  /** Legacy combined state: success | failure | pending | error | null. */
  combinedState: string | null;
}

/** Outcome for one kind of CI check: failure > pending > success > none. */
export function ciKindOutcome(
  ci: Pick<CiSignal, "checkRuns">,
  kind: CheckKind,
): "failure" | "pending" | "success" | "none" {
  const runs = ci.checkRuns.filter((run) => run.kind === kind);
  if (runs.length === 0) return "none";
  const effects = runs.map((run) => run.effective);
  if (effects.includes("failure")) return "failure";
  if (effects.includes("pending")) return "pending";
  if (effects.includes("success")) return "success";
  return "none"; // every run of this kind was skipped/neutral
}


export interface TestFilesSignal {
  count: number;
  files: string[];
  /** Test cases added, counted by regexes on added lines (plan §6). */
  addedTestCases: number;
}

export interface Signals {
  testFilesChanged: TestFilesSignal;
  skippedOrFocusedTests: SkippedOrFocusedTest[];
  ci: CiSignal;
  /** Queued/in_progress check runs exist (correction 5: tests_pass -> UNVERIFIED). */
  ciPending: boolean;
  removedExports: RemovedExport[];
  signatureChanges: SignatureChange[];
  dependencyChanges: DependencyChange[];
  docsChanged: { count: number; files: string[] };
}

/** Stable signal keys — the guard validates `signal` evidence against these. */
export const SIGNAL_KEYS = [
  "testFilesChanged",
  "skippedOrFocusedTests",
  "ci",
  "ciPending",
  "removedExports",
  "signatureChanges",
  "dependencyChanges",
  "docsChanged",
] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export function isSignalKey(key: string): key is SignalKey {
  return (SIGNAL_KEYS as readonly string[]).includes(key);
}

/** True when the signal actually has content (an empty signal cannot be cited). */
export function signalHasContent(signals: Signals, key: SignalKey): boolean {
  switch (key) {
    case "testFilesChanged":
      return signals.testFilesChanged.count > 0;
    case "skippedOrFocusedTests":
      return signals.skippedOrFocusedTests.length > 0;
    case "ci":
      return !signals.ci.none;
    case "ciPending":
      return signals.ciPending;
    case "removedExports":
      return signals.removedExports.length > 0;
    case "signatureChanges":
      return signals.signatureChanges.length > 0;
    case "dependencyChanges":
      return signals.dependencyChanges.length > 0;
    case "docsChanged":
      return signals.docsChanged.count > 0;
  }
}

// ---------------------------------------------------------------------------
// Test-file / test-case heuristics
// ---------------------------------------------------------------------------

const ADDED_TEST_CASE_PATTERNS: RegExp[] = [
  /(?:^|[^A-Za-z0-9_$.])it\s*\(\s*["'`]/,
  /(?:^|[^A-Za-z0-9_$.])test\s*\(\s*["'`]/,
  /(?:^|[^A-Za-z0-9_$.])describe\s*\(\s*["'`]/,
  /\bdef\s+test_[A-Za-z0-9_]+/,
  /\bfunc\s+Test[A-Za-z0-9_]+/,
  /@Test\b/,
];

const SKIP_MARKERS = [
  ".skip(",
  "xit(",
  "xdescribe(",
  "it.only(",
  "test.only(",
  "describe.only(",
  "@pytest.mark.skip",
  "t.Skip(",
];

function computeTestFilesSignal(bundle: PrBundle): TestFilesSignal {
  const files: string[] = [];
  let addedTestCases = 0;
  for (const file of bundle.files) {
    if (file.isTest && file.status !== "removed") {
      files.push(file.path);
    }
    if (file.patch === null) continue;
    eachPatchLine(file.patch, (entry: PatchLine) => {
      if (entry.kind !== "add") return;
      for (const pattern of ADDED_TEST_CASE_PATTERNS) {
        if (pattern.test(entry.text)) {
          addedTestCases++;
          break;
        }
      }
    });
  }
  return { count: files.length, files, addedTestCases };
}

function computeSkippedOrFocusedTests(bundle: PrBundle): SkippedOrFocusedTest[] {
  const found: SkippedOrFocusedTest[] = [];
  for (const file of bundle.files) {
    if (file.patch === null) continue;
    eachPatchLine(file.patch, (entry: PatchLine) => {
      if (entry.kind !== "add") return;
      for (const marker of SKIP_MARKERS) {
        if (entry.text.includes(marker)) {
          found.push({ file: file.path, line: entry.line, marker });
          break;
        }
      }
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// removedExports / signatureChanges (correction 4)
// ---------------------------------------------------------------------------

interface ExportSymbol {
  name: string;
  kind: RemovedExport["kind"];
  /** Exact trimmed source line, to detect moves (same line re-added). */
  line: string;
}

const EXPORT_PATTERNS: Array<{
  pattern: RegExp;
  kind: RemovedExport["kind"];
  scope: "js" | "py" | "go" | "java";
  /** Capture group holding the symbol name. */
  nameGroup: number;
}> = [
  // export function/class/type/interface/enum/const/let/var NAME
  {
    pattern: /^\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|type|interface|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
    scope: "js",
    nameGroup: 2,
  },
  { pattern: /^class\s+([A-Za-z_]\w*)/, kind: "class", scope: "py", nameGroup: 1 },
  { pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", scope: "py", nameGroup: 1 },
  { pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function", scope: "go", nameGroup: 1 },
  { pattern: /^type\s+([A-Za-z_]\w*)\s/, kind: "type", scope: "go", nameGroup: 1 },
  // public (static) TYPE NAME(
  {
    pattern: /^\s*public\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>[\],.\s]+\s+([A-Za-z_]\w*)\s*\(/,
    kind: "method",
    scope: "java",
    nameGroup: 1,
  },
];

function symbolsInLine(text: string): ExportSymbol[] {
  const found: ExportSymbol[] = [];
  for (const { pattern, kind, scope, nameGroup } of EXPORT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const name = match[nameGroup];
    if (name === undefined) continue; // e.g. `export default function` with no name
    // Language-specific visibility rules: only public/exported API counts.
    if (scope === "py" && name.startsWith("_")) continue;
    if (scope === "go" && !/^[A-Z]/.test(name)) continue;
    found.push({ name, kind, line: text.trim() });
  }
  // `export { a as b, c }` — named export list.
  const namedExports = text.match(/^\s*export\s*\{([^}]*)\}/);
  if (namedExports) {
    for (const rawName of namedExports[1].split(",")) {
      const parts = rawName.trim().split(/\s+as\s+/);
      const exportedName = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exportedName)) {
        found.push({ name: exportedName, kind: "variable", line: text.trim() });
      }
    }
  }
  return found;
}

function computeRemovedExports(
  bundle: PrBundle,
): { removedExports: RemovedExport[]; signatureChanges: SignatureChange[] } {
  const addedSymbols = new Map<string, string>(); // name -> path it was added in
  const addedLines = new Set<string>(); // trimmed added line text (move detection)

  for (const file of bundle.files) {
    if (file.patch === null) continue;
    eachPatchLine(file.patch, (entry: PatchLine) => {
      if (entry.kind !== "add") return;
      addedLines.add(entry.text.trim());
      for (const symbol of symbolsInLine(entry.text)) {
        addedSymbols.set(symbol.name, file.path);
      }
    });
  }

  const removedExports: RemovedExport[] = [];
  const signatureChanges: SignatureChange[] = [];
  const seen = new Set<string>();

  for (const file of bundle.files) {
    if (file.patch === null) continue;
    eachPatchLine(file.patch, (entry: PatchLine) => {
      if (entry.kind !== "del") return;
      for (const symbol of symbolsInLine(entry.text)) {
        const dedupeKey = `${file.path}:${symbol.name}`;
        if (seen.has(dedupeKey)) continue;
        // Same exact line re-added anywhere -> just a move, neither signal.
        if (addedLines.has(symbol.line)) continue;
        if (addedSymbols.has(symbol.name)) {
          signatureChanges.push({
            symbol: symbol.name,
            path: file.path,
            readdedIn: addedSymbols.get(symbol.name) ?? file.path,
          });
        } else {
          removedExports.push({ symbol: symbol.name, path: file.path, kind: symbol.kind });
        }
        seen.add(dedupeKey);
      }
    });
  }
  return { removedExports, signatureChanges };
}

// ---------------------------------------------------------------------------
// dependencyChanges (plan §6)
// ---------------------------------------------------------------------------

function majorOf(version: string): number | null {
  const match = version.match(/[~^><=|\s]*v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

interface DepSpec {
  name: string;
  version: string;
}

function dependencySpecs(path: string, text: string): DepSpec[] {
  const specs: DepSpec[] = [];
  if (/(^|\/)go\.mod$/i.test(path)) {
    const match = text.match(/^\s*([\w./~-]+[\w/-])\s+(v\d+[\w.-]*)/);
    if (match) specs.push({ name: match[1], version: match[2] });
    return specs;
  }
  if (/(^|\/)requirements[a-z0-9.-]*\.txt$/i.test(path)) {
    const match = text.match(/^\s*([A-Za-z0-9_.-]+)\s*[=~<>!]=?\s*([A-Za-z0-9.!+_-]+)/);
    if (match) specs.push({ name: match[1], version: match[2] });
    return specs;
  }
  if (/(^|\/)Gemfile$/i.test(path)) {
    const match = text.match(/^\s*gem\s+["']([^"']+)["']\s*,\s*[\(<]*\s*["']?[~^>]?(\d[^"')\s]*)/);
    if (match) specs.push({ name: match[1], version: match[2] });
    return specs;
  }
  if (/\.json$/i.test(path)) {
    // package.json / composer.json: "name": "^1.2.3"
    for (const match of text.matchAll(/"([^"]+)"\s*:\s*"[~^><=|\s]*v?(\d[^"]*)"/g)) {
      specs.push({ name: match[1], version: match[2] });
    }
    return specs;
  }
  // TOML (pyproject.toml, Cargo.toml): name = "1.2.3"
  const match = text.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*[{"]?[~^]?(\d[^",;\s}]*)/);
  if (match) specs.push({ name: match[1], version: match[2] });
  return specs;
}

function computeDependencyChanges(bundle: PrBundle): DependencyChange[] {
  const changes: DependencyChange[] = [];
  for (const file of bundle.files) {
    if (file.patch === null || !isDependencyManifest(file.path) || file.status === "removed") {
      continue;
    }
    const removedSpecs = new Map<string, string>();
    const addedSpecs = new Map<string, string>();
    eachPatchLine(file.patch, (entry: PatchLine) => {
      for (const spec of dependencySpecs(file.path, entry.text)) {
        if (entry.kind === "del") removedSpecs.set(spec.name, spec.version);
        else if (entry.kind === "add") addedSpecs.set(spec.name, spec.version);
      }
    });
    const majorBumps: string[] = [];
    let updatedCount = 0;
    for (const [name, toVersion] of addedSpecs) {
      const fromVersion = removedSpecs.get(name);
      if (fromVersion === undefined) continue;
      updatedCount++;
      const fromMajor = majorOf(fromVersion);
      const toMajor = majorOf(toVersion);
      if (fromMajor !== null && toMajor !== null && fromMajor !== toMajor) {
        majorBumps.push(`${name} ${fromMajor}→${toMajor}`);
      }
    }
    if (removedSpecs.size + addedSpecs.size > 0) {
      changes.push({ path: file.path, updatedCount, majorBumps });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// CI signal
// ---------------------------------------------------------------------------

/**
 * Computes the CI signal: every check run and legacy status gets a kind
 * (test/lint/typecheck/build/deploy/bot/other) and an effective outcome,
 * with skipped/neutral/stale treated as ignorable (Bug 3): they neither
 * pass nor fail. Overall outcome: failure > pending > success; "none"
 * covers both "no CI at all" and "nothing actually executed".
 */
export function computeCiSignal(bundle: PrBundle): CiSignal {
  const observations: CiObservation[] = bundle.checkRuns.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.htmlUrl,
    kind: classifyCheckName(run.name),
    effective: effectiveCheckEffect(run.status, run.conclusion ?? null),
  }));
  for (const status of bundle.combinedStatus?.statuses ?? []) {
    observations.push({
      name: status.context,
      // Legacy statuses have no separate status/conclusion pair; classify
      // directly from the state.
      status: legacyStateToStatusField(status.state),
      conclusion: status.state,
      htmlUrl: status.targetUrl ?? bundle.prUrl,
      kind: classifyCheckName(status.context),
      effective: legacyStateEffect(status.state),
    });
  }

  const combinedState = bundle.combinedStatus?.state ?? null;
  const executed = observations.filter((observed) => observed.effective !== "ignored");
  const none = observations.length === 0 || executed.length === 0;
  const pending = executed.some((observed) => observed.effective === "pending");
  const anyFailed = executed.some((observed) => observed.effective === "failure");
  const anySuccess = executed.some((observed) => observed.effective === "success");

  let outcome: CiSignal["outcome"];
  if (none) outcome = "none";
  else if (anyFailed) outcome = "failure";
  else if (pending) outcome = "pending";
  else if (anySuccess) outcome = "success";
  else outcome = "pending";

  return {
    none,
    outcome,
    pending,
    checkRuns: observations,
    combinedState,
  };
}

/** Legacy combined-status state -> effective outcome. */
function legacyStateEffect(state: string): CheckEffect {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "pending") return "pending";
  return "ignored";
}

/** Legacy combined-status state -> the status field the CI API vocabulary would use. */
function legacyStateToStatusField(state: string): string {
  return state === "pending" ? "pending" : "completed";
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Computes all deterministic signals for one PR bundle. */
export function computeSignals(bundle: PrBundle): Signals {
  const { removedExports, signatureChanges } = computeRemovedExports(bundle);
  const ci = computeCiSignal(bundle);
  const testFiles = computeTestFilesSignal(bundle);
  const docsFiles = bundle.files
    .filter((file) => isDocPath(file.path))
    .map((file) => file.path);
  return {
    testFilesChanged: testFiles,
    skippedOrFocusedTests: computeSkippedOrFocusedTests(bundle),
    ci,
    ciPending: ci.pending,
    removedExports,
    signatureChanges,
    dependencyChanges: computeDependencyChanges(bundle),
    docsChanged: { count: docsFiles.length, files: docsFiles.slice(0, 10) },
  };
}

const MAX_LIST = 3;

/** Distinct failing check names (max 3) with their kind, e.g. "Format (Biome) [lint]". */
function distinctKindNames(
  ci: Pick<CiSignal, "checkRuns">,
  effect: CheckEffect,
): string[] {
  return ci.checkRuns
    .filter((run) => run.effective === effect)
    .map((run) => `${run.name} [${run.kind}]`)
    .slice(0, MAX_LIST);
}

/** Human-readable summary lines for the report (one per non-empty signal + CI). */
export function buildSignalsSummary(signals: Signals): string[] {
  const lines: string[] = [];
  const { testFilesChanged, ci } = signals;
  if (testFilesChanged.count === 0) {
    lines.push("No test files changed");
  } else {
    lines.push(
      `${testFilesChanged.count} test file(s) changed · ${testFilesChanged.addedTestCases} new test case(s) detected`,
    );
  }
  if (signals.skippedOrFocusedTests.length > 0) {
    const first = signals.skippedOrFocusedTests[0];
    lines.push(
      `${signals.skippedOrFocusedTests.length} skip/only marker(s) added (e.g. \`${first.marker}\` in ${first.file}:${first.line})`,
    );
  }
  switch (ci.outcome) {
    case "none": {
      const ignored = ci.checkRuns.filter((run) => run.effective === "ignored").length;
      lines.push(
        ignored > 0
          ? `No CI checks executed for head SHA (all ${ignored} check(s) skipped/neutral)`
          : "No CI checks reported for head SHA",
      );
      break;
    }
    case "pending": {
      const pendingCount = ci.checkRuns.filter((run) => run.effective === "pending").length;
      const failing = distinctKindNames(ci, "failure");
      lines.push(
        `CI still running (${pendingCount} check(s) pending)` +
          (failing.length > 0 ? `; failing: ${failing.join(", ")}` : ""),
      );
      break;
    }
    case "failure": {
      lines.push(`CI failing for head SHA (failed: ${distinctKindNames(ci, "failure").join(", ")})`);
      break;
    }
    case "success": {
      const succeeded = ci.checkRuns.filter((run) => run.effective === "success").length;
      lines.push(`CI passing (${succeeded} check run(s) succeeded)`);
      break;
    }
  }
  const testKindOutcome = ciKindOutcome(ci, "test");
  if (testKindOutcome === "none" && !ci.none) {
    lines.push("No CI check runs tests for head SHA");
  } else if (testKindOutcome === "pending" && ci.outcome !== "pending") {
    lines.push("Test-type CI checks still running");
  }
  if (signals.removedExports.length > 0) {
    const listed = signals.removedExports
      .slice(0, MAX_LIST)
      .map((entry) => `${entry.symbol} (${entry.path})`)
      .join(", ");
    const more = signals.removedExports.length > MAX_LIST ? ", …" : "";
    lines.push(`${signals.removedExports.length} public export(s) removed: ${listed}${more}`);
  }
  if (signals.signatureChanges.length > 0) {
    const listed = signals.signatureChanges
      .slice(0, MAX_LIST)
      .map((change) => `${change.symbol} (${change.path} → ${change.readdedIn})`)
      .join(", ");
    lines.push(`${signals.signatureChanges.length} signature change(s): ${listed}`);
  }
  if (signals.dependencyChanges.length > 0) {
    for (const change of signals.dependencyChanges.slice(0, MAX_LIST)) {
      const bumps = change.majorBumps.length > 0 ? ` — major bumps: ${change.majorBumps.join(", ")}` : "";
      lines.push(`Dependency file changed: ${change.path}${bumps}`);
    }
  }
  if (signals.docsChanged.count > 0) {
    lines.push(`Docs changed: ${signals.docsChanged.count} file(s)`);
  }
  return lines;
}
