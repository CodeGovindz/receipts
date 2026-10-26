import { describe, expect, it } from "vitest";
import {
  buildSignalsSummary,
  ciKindOutcome,
  classifyCheckName,
  computeCiSignal,
  effectiveCheckEffect,
} from "../signals";
import type { PrBundle } from "../types";

function bundleWith(
  checkRuns: Array<{ name: string; conclusion: string | null; status?: string }>,
  statuses: Array<{ context: string; state: string }> = [],
): PrBundle {
  return {
    prUrl: "https://github.com/acme/widget/pull/1",
    owner: "acme",
    repo: "widget",
    number: 1,
    title: "t",
    body: null,
    author: "a",
    headSha: "a".repeat(40),
    files: [],
    commits: [],
    checkRuns: checkRuns.map((run) => ({
      name: run.name,
      status: run.status ?? "completed",
      conclusion: run.conclusion,
      htmlUrl: "https://example.com/ci/1",
    })),
    combinedStatus:
      statuses.length > 0
        ? {
            state: statuses[0].state,
            statuses: statuses.map((status) => ({
              context: status.context,
              state: status.state,
              targetUrl: null,
            })),
          }
        : null,
    fetchedAt: new Date().toISOString(),
    filesTruncated: false,
    commitsTruncated: false,
  };
}

describe("classifyCheckName", () => {
  it.each([
    ["build and test", "test"], // test outranks build
    ["Rust tests (Linux)", "test"],
    ["Integration tests", "test"],
    ["pytest", "test"],
    ["Format (Biome)", "lint"],
    ["Clippy", "lint"],
    ["Typecheck", "typecheck"],
    ["Build GPUI Desktop", "build"],
    ["Deploy to production", "deploy"],
    ["Vercel – cap-web", "deploy"],
    ["Vercel Agent Review", "bot"], // bot outranks deploy
    ["Socket Security: Pull Request Alerts", "bot"],
    ["Codecov", "bot"],
    ["Greptile Review", "bot"],
    ["Deep review label", "bot"],
    ["Verify Tauri plugin versions", "other"],
    ["Perf budget", "other"],
  ])("%s -> %s", (name, kind) => {
    expect(classifyCheckName(name)).toBe(kind);
  });
});

describe("effectiveCheckEffect (Bug 3: skipped/neutral/stale are ignorable)", () => {
  it.each([
    ["completed", "success", "success"],
    ["completed", "failure", "failure"],
    ["completed", "timed_out", "failure"],
    ["completed", "skipped", "ignored"],
    ["completed", "neutral", "ignored"],
    ["completed", "stale", "ignored"],
    ["queued", null, "pending"],
    ["in_progress", null, "pending"],
    ["completed", null, "ignored"],
  ])("%s/%s -> %s", (status, conclusion, effect) => {
    expect(effectiveCheckEffect(status, conclusion)).toBe(effect);
  });
});

describe("computeCiSignal", () => {
  it("treats all-skipped runs as 'none' (no executed checks)", () => {
    const ci = computeCiSignal(
      bundleWith([
        { name: "Rust tests (Linux)", conclusion: "skipped" },
        { name: "Format (Biome)", conclusion: "neutral" },
        { name: "Stale check", conclusion: "stale" },
      ]),
    );
    expect(ci.none).toBe(true);
    expect(ci.outcome).toBe("none");
    const summary = buildSignalsSummary({
      testFilesChanged: { count: 0, files: [], addedTestCases: 0 },
      skippedOrFocusedTests: [],
      ci,
      ciPending: ci.pending,
      removedExports: [],
      signatureChanges: [],
      dependencyChanges: [],
      docsChanged: { count: 0, files: [] },
    });
    expect(
      summary.some((line) => line.includes("No CI checks executed") && line.includes("3")),
    ).toBe(true);
  });

  it("reports success when real successes exist alongside skipped runs", () => {
    const ci = computeCiSignal(
      bundleWith([
        { name: "Unit tests", conclusion: "success" },
        { name: "Rust tests (Linux)", conclusion: "skipped" },
        { name: "Docs build", conclusion: "neutral" },
      ]),
    );
    expect(ci.outcome).toBe("success");
    expect(ci.pending).toBe(false);
    expect(ciKindOutcome(ci, "test")).toBe("success");
  });

  it("a failing deploy check marks the overall outcome failure but leaves the test kind unaffected", () => {
    const ci = computeCiSignal(
      bundleWith([
        { name: "Unit tests", conclusion: "success" },
        { name: "Vercel – cap-web", conclusion: "failure" },
        { name: "Rust tests (Linux)", conclusion: "skipped" },
      ]),
    );
    expect(ci.outcome).toBe("failure");
    expect(ciKindOutcome(ci, "test")).toBe("success");
    expect(ciKindOutcome(ci, "deploy")).toBe("failure");
  });

  it("pending still beats success for the overall outcome while CI runs", () => {
    const ci = computeCiSignal(
      bundleWith([
        { name: "Documentation", conclusion: "success" },
        { name: "Unit tests", conclusion: null, status: "in_progress" },
      ]),
    );
    expect(ci.outcome).toBe("pending");
    expect(ci.pending).toBe(true);
    expect(ciKindOutcome(ci, "test")).toBe("pending");
  });

  it("classifies legacy statuses as observations with kinds", () => {
    const ci = computeCiSignal(bundleWith([], [{ context: "ci/pytest", state: "success" }]));
    expect(ci.outcome).toBe("success");
    expect(ci.checkRuns[0].kind).toBe("test");
    expect(ci.checkRuns[0].effective).toBe("success");
    const legacyError = computeCiSignal(bundleWith([], [{ context: "ci/tests", state: "error" }]));
    expect(legacyError.outcome).toBe("failure");
    expect(ciKindOutcome(legacyError, "test")).toBe("failure");
  });

  it("a repo with no CI at all is 'none'", () => {
    const ci = computeCiSignal(bundleWith([]));
    expect(ci.none).toBe(true);
    expect(ci.outcome).toBe("none");
    expect(ciKindOutcome(ci, "test")).toBe("none");
  });

  it("summary names the failing checks with their kinds", () => {
    const ci = computeCiSignal(
      bundleWith([
        { name: "Format (Biome)", conclusion: "failure" },
        { name: "Vercel – cap-web", conclusion: "failure" },
        { name: "Unit tests", conclusion: "success" },
      ]),
    );
    const summary = buildSignalsSummary({
      testFilesChanged: { count: 0, files: [], addedTestCases: 0 },
      skippedOrFocusedTests: [],
      ci,
      ciPending: ci.pending,
      removedExports: [],
      signatureChanges: [],
      dependencyChanges: [],
      docsChanged: { count: 0, files: [] },
    });
    const ciLine = summary.find((line) => line.includes("CI failing"));
    expect(ciLine).toBeDefined();
    expect(ciLine ?? "").toContain("Format (Biome) [lint]");
    expect(ciLine ?? "").toContain("Vercel – cap-web [deploy]");
  });
});
