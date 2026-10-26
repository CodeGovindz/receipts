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

export interface CiSignal {
  /** True when the head SHA has neither check runs nor legacy statuses. */
  none: boolean;
  /** Outcome roll-up: "none" | "pending" | "success" | "failure". */
  outcome: "none" | "pending" | "success" | "failure";
  pending: boolean;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null; htmlUrl: string }>;
  /** Legacy combined status: success | failure | pending | error | null. */
  combinedState: string | null;
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

function computeCiSignal(bundle: PrBundle): CiSignal {
  const pendingStatuses = new Set(["queued", "in_progress"]);
  const failedConclusions = new Set(["failure", "timed_out", "cancelled"]);
  const failedStates = new Set(["failure", "error"]);

  const checkRuns = bundle.checkRuns.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.htmlUrl,
  }));
  const statuses = bundle.combinedStatus?.statuses ?? [];
  const none = checkRuns.length === 0 && statuses.length === 0;
  const combinedState = bundle.combinedStatus?.state ?? null;
  const anyStatusPending =
    (bundle.combinedStatus?.statuses.some((status) => status.state === "pending") ?? false) ||
    combinedState === "pending";
  const pending = checkRuns.some((run) => pendingStatuses.has(run.status)) || anyStatusPending;
  const anyFailed =
    checkRuns.some((run) => run.conclusion !== null && failedConclusions.has(run.conclusion)) ||
    statuses.some((status) => failedStates.has(status.state));
  const allPassed =
    checkRuns.length > 0 &&
    checkRuns.every((run) => (run.status === "completed" ? run.conclusion === "success" : false)) &&
    [...statuses].every((status) => status.state === "success");

  let outcome: CiSignal["outcome"];
  if (none) outcome = "none";
  else if (anyFailed) outcome = "failure";
  else if (pending) outcome = "pending";
  else if (allPassed) outcome = "success";
  else outcome = "pending";

  return {
    none,
    outcome,
    pending,
    checkRuns,
    combinedState,
  };
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
    case "none":
      lines.push("No CI checks reported for head SHA");
      break;
    case "pending":
      lines.push(`CI still running (${ci.checkRuns.length} check run(s) for head SHA)`);
      break;
    case "failure":
      lines.push("CI failing for head SHA (at least one check run failed)");
      break;
    case "success":
      lines.push(`CI passing (${ci.checkRuns.length} check run(s) succeeded)`);
      break;
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
