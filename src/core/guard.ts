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
import { isSignalKey, signalHasContent, type Signals } from "./signals";
import type { Claim, ClaimEvidence, EvidenceItem, PrBundle, Verdict } from "./types";

/** Verdict fields AFTER the guards had their say. */
export interface GuardedVerdict {
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  evidence: ClaimEvidence[];
}

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
 *    otherwise link the file without a line anchor.
 * 3. Downgrade — VERIFIED/CONTRADICTED with zero surviving evidence becomes
 *    UNVERIFIED ("model gave no checkable evidence").
 * 4. CI-pending rule (correction 5) — tests_pass cannot be VERIFIED while
 *    CI is still queued/running; becomes UNVERIFIED "CI still running".
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

  // Correction 5: a tests_pass claim cannot be VERIFIED while CI runs.
  if (claim.category === "tests_pass" && verdict === "VERIFIED" && signals.ciPending) {
    verdict = "UNVERIFIED";
    reasoning = "CI still running.";
  }

  return {
    verdict,
    confidence: Math.min(1, Math.max(0, response.confidence)),
    reasoning,
    evidence: kept,
  };
}
