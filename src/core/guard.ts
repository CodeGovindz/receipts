/**
 * Judge-facing guards (docs/PLAN.md §7, corrections 3 & 5).
 *
 * The STRONG model's verdict is only as trustworthy as the evidence it
 * cites. These guards run AFTER the model and are the hard backstop against
 * prompt injection: a hostile PR body that tricks the model into saying
 * VERIFIED cannot mint evidence, because every cited item must actually
 * exist in the bundle (path, check run, or signal) and every cited line
 * must fall inside a changed hunk.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import {
  ciKindOutcome,
  claimCheckKindHints,
  isSignalKey,
  signalHasContent,
  type CheckKind,
  type Signals,
} from "./signals";
import type { Claim, ClaimEvidence, EvidenceItem, PrBundle, Verdict } from "./types";

/** Verdict fields AFTER the guards had their say. */
export interface GuardedVerdict {
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  evidence: ClaimEvidence[];
}

/** CONTRADICTED verdicts below this confidence are downgraded to UNVERIFIED. */
export const LOW_CONTRADICTION_CONFIDENCE = 0.75;

/** Path is indexable by claim evidence: it must be in the changed-files list. */
function changedFilePaths(bundle: PrBundle): Set<string> {
  const paths = new Set<string>();
  for (const file of bundle.files) {
    paths.add(file.path);
    if (file.previousPath) paths.add(file.previousPath);
  }
  return paths;
}

/** True when `line` falls inside a new-file hunk range of `path`. */
export function lineInsideHunk(bundle: PrBundle, path: string, line: number): boolean {
  const file = bundle.files.find((candidate) => candidate.path === path);
  if (!file || !file.hunks) return false;
  return file.hunks.some(
    (hunk) => hunk.newLines > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newLines,
  );
}

function blobUrl(bundle: PrBundle, path: string, line: number | null): string {
  const base = `https://github.com/${bundle.owner}/${bundle.repo}/blob/${bundle.headSha}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  return line !== null ? `${base}#L${line}` : base;
}

function isCheckRunInBundle(name: string, bundle: PrBundle): { url: string } | null {
  const checkRun = bundle.checkRuns.find((run) => run.name === name);
  if (checkRun) return { url: checkRun.htmlUrl };
  const legacy = bundle.combinedStatus?.statuses.find((status) => status.context === name);
  if (legacy) return { url: legacy.targetUrl ?? bundle.prUrl };
  return null;
}

function signalKeyOf(item: EvidenceItem): string | null {
  const candidates = [item.detail, item.path, item.checkRunName];
  for (const candidate of candidates) {
    const key = (candidate ?? "").trim();
    if (isSignalKey(key)) return key;
  }
  return null;
}

/**
 * Applies all guards to one raw model verdict:
 *
 * 1. Citation guard — drop evidence items that do not exist in the bundle
 *    (unknown file path / check run / signal key, or an empty signal).
 * 2. Line guard — keep `line` only inside a changed hunk's new-file range;
 *    otherwise the link degrades to the file (no #L anchor).
 * 3. Downgrade — VERIFIED/CONTRADICTED with zero surviving evidence becomes
 *    UNVERIFIED ("model gave no checkable evidence").
 * 4. tests_pass kind rule (deterministic; plan review Bugs 2/3, correction
 *    5) — pass/contradiction verdicts must be supported by CI checks of the
 *    kind the claim talks about; a local-scope pass claim is never
 *    CI-confirmable; pending CI blocks VERIFIED.
 * 5. Low-confidence rule (Bug 5) — remaining CONTRADICTED verdicts with
 *    confidence < 0.75 become UNVERIFIED.
 */
export function applyGuards(
  claim: Claim,
  response: { verdict: Verdict; confidence: number; reasoning: string; evidence: EvidenceItem[] },
  bundle: PrBundle,
  signals: Signals,
): GuardedVerdict {
  const paths = changedFilePaths(bundle);
  const kept: ClaimEvidence[] = [];

  for (const item of response.evidence ?? []) {
    if (item.type === "file" && typeof item.path === "string") {
      if (!paths.has(item.path)) continue; // cited path is not in this PR
      const rawLine = typeof item.line === "number" && Number.isInteger(item.line) ? item.line : null;
      // Line guard: only lines inside a changed hunk survive.
      const line = rawLine !== null && lineInsideHunk(bundle, item.path, rawLine) ? rawLine : null;
      kept.push({
        type: "file",
        path: item.path,
        line,
        checkRunName: null,
        detail: item.detail ?? null,
        url: blobUrl(bundle, item.path, line),
      });
    } else if (item.type === "check_run") {
      const name = item.checkRunName ?? item.detail ?? "";
      const match = isCheckRunInBundle(name, bundle);
      if (!match) continue; // named check does not exist for head SHA
      kept.push({
        type: "check_run",
        path: null,
        line: null,
        checkRunName: name,
        detail: item.detail ?? null,
        url: match.url,
      });
    } else if (item.type === "signal") {
      const key = signalKeyOf(item);
      if (key === null) continue;
      // The signal must be a known key AND actually have content.
      if (!isSignalKey(key) || !signalHasContent(signals, key)) continue;
      kept.push({
        type: "signal",
        path: null,
        line: null,
        checkRunName: null,
        detail: key,
        url: null,
      });
    }
  }

  let verdict: Verdict = response.verdict;
  let reasoning: string = response.reasoning;

  if ((verdict === "VERIFIED" || verdict === "CONTRADICTED") && kept.length === 0) {
    verdict = "UNVERIFIED";
    reasoning = "Model gave no checkable evidence.";
  }

  // Bug 2 (deterministic backstop) — a tests_pass verdict must match the CI
  // evidence by kind, regardless of what the model decided this run:
  //   VERIFIED only while every kind the claim talks about succeeded;
  //   CONTRADICTED only if the claim is refuted by a failed check of a kind
  //   the claim actually makes a statement about ("all tests pass" needs a
  //   failed test-kind check; "Biome checks pass" is refuted by failed lint).
  const testsPassRuled = applyTestsPassKindRule(claim, verdict, kept, signals);
  verdict = testsPassRuled.verdict;
  if (testsPassRuled.reasoning !== undefined) {
    reasoning = testsPassRuled.reasoning;
  }
  if (verdict === "VERIFIED") {
    kept.push(...passingKindEvidence(claim, kept, signals));
  }

  // Bug 5 — precision guard: a CONTRADICTED verdict is the most damaging thing
  // Receipts can say (it forces a FAIL grade), so a low-confidence
  // contradiction is downgraded to UNVERIFIED rather than risking a false one.
  if (verdict === "CONTRADICTED" && response.confidence < LOW_CONTRADICTION_CONFIDENCE) {
    verdict = "UNVERIFIED";
    reasoning = `Low-confidence contradiction (${response.confidence.toFixed(2)}): ${response.reasoning}`;
  }

  return {
    verdict,
    confidence: Math.min(1, Math.max(0, response.confidence)),
    reasoning,
    evidence: kept,
  };
}

/** The check kinds a tests_pass claim makes a statement about. */
function enforcedKindsOf(claim: Claim): CheckKind[] {
  const hints = claimCheckKindHints(`${claim.text} ${claim.quote}`);
  return hints.length > 0 ? hints : ["test"];
}

/**
 * A VERIFIED tests_pass verdict is backed by the passing checks of the kinds
 * the claim talks about, so the report links to the actual test jobs even
 * when the model cited something else (e.g. a build check). Max 3 added.
 */
function passingKindEvidence(
  claim: Claim,
  kept: ClaimEvidence[],
  signals: Signals,
): ClaimEvidence[] {
  if (claim.category !== "tests_pass") return [];
  const kinds = enforcedKindsOf(claim);
  const cited = new Set(kept.map((item) => item.checkRunName));
  return signals.ci.checkRuns
    .filter(
      (run) => run.effective === "success" && kinds.includes(run.kind) && !cited.has(run.name),
    )
    .slice(0, 3)
    .map((run) => ({
      type: "check_run" as const,
      path: null,
      line: null,
      checkRunName: run.name,
      detail: `${run.kind} check passed`,
      url: run.htmlUrl,
    }));
}

/**
 * Deterministic tests_pass rules (plan review Bugs 2/3, correction 5).
 * Returns the (possibly downgraded) verdict + a replacement reason when a
 * rule fired. Non-tests_pass claims and UNVERIFIED verdicts pass through.
 */
function applyTestsPassKindRule(
  claim: Claim,
  verdict: Verdict,
  kept: ClaimEvidence[],
  signals: Signals,
): { verdict: Verdict; reasoning?: string } {
  if (claim.category !== "tests_pass") return { verdict };
  if (verdict !== "VERIFIED" && verdict !== "CONTRADICTED") return { verdict };

  // "tests pass" without any specific kind defaults to plain test-kind semantics.
  const enforcedKinds = enforcedKindsOf(claim);

  if (verdict === "CONTRADICTED") {
    // A contradiction must cite a FAILED check of an enforced kind.
    const citesMatchingFailure = kept.some((item) => {
      if (item.type !== "check_run" || item.checkRunName === null) return false;
      const observed = signals.ci.checkRuns.find((run) => run.name === item.checkRunName);
      return (
        observed !== undefined &&
        observed.effective === "failure" &&
        enforcedKinds.includes(observed.kind)
      );
    });
    if (citesMatchingFailure) return { verdict };
    const failingKinds = [
      ...new Set(
        signals.ci.checkRuns
          .filter((run) => run.effective === "failure")
          .map((run) => run.kind),
      ),
    ].join("/");
    return {
      verdict: "UNVERIFIED",
      reasoning:
        "No CI check of the kind this claim makes has failed" +
        (failingKinds.length > 0 ? ` (failing checks are: ${failingKinds}).` : "."),
    };
  }

  // VERIFIED: every enforced kind must have succeeded — none failed, none pending.
  for (const kind of enforcedKinds) {
    const outcome = ciKindOutcome(signals.ci, kind);
    if (outcome === "failure") {
      return { verdict: "UNVERIFIED", reasoning: `A CI check of kind "${kind}" failed.` };
    }
    if (outcome === "pending") {
      return { verdict: "UNVERIFIED", reasoning: "CI still running." };
    }
    if (!signals.ci.checkRuns.some((run) => run.kind === kind)) {
      return { verdict: "UNVERIFIED", reasoning: `No CI job of kind "${kind}" runs for this repo.` };
    }
    if (outcome === "none") {
      return { verdict: "UNVERIFIED", reasoning: `CI checks of kind "${kind}" were skipped.` };
    }
  }
  // Local-scope pass claims ("all tests pass locally") can never be
  // confirmed by repo CI, even when the same-named checks are green.
  if (claim.scope === "local") {
    return {
      verdict: "UNVERIFIED",
      reasoning: "Claim refers to runs on the author's machine; CI cannot confirm them.",
    };
  }
  return { verdict };
}
