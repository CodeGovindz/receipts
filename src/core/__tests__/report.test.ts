import { describe, expect, it } from "vitest";
import { buildReport, computeGrade, computeTrustScore, modelsFooter, toMarkdown, toJSON } from "../report";
import type { BuildReportInput } from "../report";
import { ReportSchema } from "../types";
import type { ClaimResult, Report, Verdict } from "../types";

function makeClaimResult(verdict: Verdict, overrides: Partial<ClaimResult> = {}): ClaimResult {
  return {
    claim: {
      text: `Claim ${Math.random().toString(36).slice(2, 8)}`,
      quote: "claims are numbered",
      source: "pr_body",
      category: "bug_fixed",
    },
    verdict,
    confidence: 0.9,
    reasoning: "Reasoning sentence one. Sentence two.",
    evidence: [],
    modelUsed: "us.moonshotai.kimi-k3",
    latencyMs: 1_500,
    ...overrides,
  };
}

describe("computeGrade (truth table)", () => {
  it("returns MIXED for zero claims", () => {
    expect(computeGrade([])).toBe("MIXED");
  });

  it("returns PASS only when every claim is VERIFIED", () => {
    expect(computeGrade([makeClaimResult("VERIFIED"), makeClaimResult("VERIFIED")])).toBe("PASS");
  });

  it("returns FAIL when any claim is CONTRADICTED, even alongside VERIFIED ones", () => {
    expect(
      computeGrade([makeClaimResult("VERIFIED"), makeClaimResult("CONTRADICTED")]),
    ).toBe("FAIL");
  });

  it("returns MIXED for VERIFIED + UNVERIFIED with no contradictions", () => {
    expect(computeGrade([makeClaimResult("VERIFIED"), makeClaimResult("UNVERIFIED")])).toBe("MIXED");
  });

  it("returns MIXED when all claims are UNVERIFIED", () => {
    expect(computeGrade([makeClaimResult("UNVERIFIED"), makeClaimResult("UNVERIFIED")])).toBe("MIXED");
  });

  it("returns FAIL when all claims are CONTRADICTED", () => {
    expect(computeGrade([makeClaimResult("CONTRADICTED")])).toBe("FAIL");
  });
});

describe("computeTrustScore", () => {
  it("is null when there are no claims (rendered —)", () => {
    expect(computeTrustScore([])).toBeNull();
  });

  it("is verified / total", () => {
    expect(
      computeTrustScore([makeClaimResult("VERIFIED"), makeClaimResult("VERIFIED"), makeClaimResult("UNVERIFIED")]),
    ).toBe(0.67);
    expect(computeTrustScore([makeClaimResult("VERIFIED")])).toBe(1);
    expect(computeTrustScore([makeClaimResult("CONTRADICTED")])).toBe(0);
  });
});

function baseInput(results: ClaimResult[], overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    prUrl: "https://github.com/acme/widget/pull/7",
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    results,
    droppedClaims: 0,
    signalsSummary: ["1 test file(s) changed", "CI passing (3 check run(s) succeeded)"],
    claimsModel: "qwen.qwen3-coder-next",
    fallbackModel: "openai.gpt-oss-120b-1:0",
    fallbackCount: 0,
    timings: {
      fetchMs: 1_000,
      extractMs: 3_000,
      verifyMs: 20_000,
      totalMs: 24_000,
      inputTokens: 12_000,
      outputTokens: 3_400,
      llmCalls: 4,
    },
    ...overrides,
  };
}

describe("buildReport", () => {
  it("grades zero claims as MIXED with trust —", () => {
    const report = buildReport(baseInput([]));
    expect(report.grade).toBe("MIXED");
    expect(report.trustScore).toBeNull();
  });

  it("aggregates modelsUsed from actual claim results, not env vars", () => {
    const report = buildReport(
      baseInput([
        makeClaimResult("VERIFIED", { modelUsed: "us.moonshotai.kimi-k3" }),
        makeClaimResult("UNVERIFIED", { modelUsed: "openai.gpt-oss-120b-1:0" }),
      ], { fallbackCount: 1 }),
    );
    expect(report.modelsUsed.claimsModel).toBe("qwen.qwen3-coder-next");
    expect(report.modelsUsed.verdictsModels).toEqual(["us.moonshotai.kimi-k3", "openai.gpt-oss-120b-1:0"]);
    expect(report.modelsUsed.fallbackCount).toBe(1);
    const footer = modelsFooter(report.modelsUsed);
    expect(footer).toBe(
      "Claims: Qwen3 Coder Next · Verdicts: Kimi K3 (1 via GPT-OSS 120B) · on Amazon Bedrock",
    );
  });

  it("says just the fallback model when every verdict came through it", () => {
    const report = buildReport(
      baseInput([makeClaimResult("VERIFIED", { modelUsed: "openai.gpt-oss-120b-1:0" })], {
        fallbackCount: 1,
      }),
    );
    expect(modelsFooter(report.modelsUsed)).toBe(
      "Claims: Qwen3 Coder Next · Verdicts: GPT-OSS 120B · on Amazon Bedrock",
    );
  });

  it("validates through the zod schema (round-trip)", () => {
    const report = buildReport(baseInput([makeClaimResult("VERIFIED")]));
    expect(() => ReportSchema.parse(report)).not.toThrow();
    const reparsed: Report = ReportSchema.parse(JSON.parse(toJSON(report)));
    expect(reparsed).toEqual(report);
  });
});

describe("toMarkdown", () => {
  it("starts with the hidden receipts marker", () => {
    const report = buildReport(baseInput([makeClaimResult("VERIFIED")]));
    const markdown = toMarkdown(report);
    expect(markdown.split("\n")[0]).toBe("<!-- receipts:report -->");
  });

  it("shows the grade, trust, icons, and footer", () => {
    const report = buildReport(
      baseInput([
        makeClaimResult("VERIFIED"),
        makeClaimResult("CONTRADICTED"),
        makeClaimResult("UNVERIFIED"),
      ]),
    );
    const markdown = toMarkdown(report);
    expect(markdown).toContain("## Receipts: FAIL · trust 33% (1/3 verified)");
    expect(markdown).toContain("| ✅ VERIFIED |");
    expect(markdown).toContain("| ❌ CONTRADICTED |");
    expect(markdown).toContain("| ⚠️ UNVERIFIED |");
    expect(markdown.trim().endsWith("*Claims: Qwen3 Coder Next · Verdicts: Kimi K3 · on Amazon Bedrock*")).toBe(true);
  });

  it("renders zero claims without a table and with trust —", () => {
    const report = buildReport(baseInput([]));
    const markdown = toMarkdown(report);
    expect(markdown).toContain("MIXED");
    expect(markdown).toContain("trust —");
    expect(markdown).toContain("No checkable claims found");
    expect(markdown).not.toContain("| Verdict |");
  });

  it("counts dropped claims", () => {
    const report = buildReport(baseInput([makeClaimResult("VERIFIED")], { droppedClaims: 2 }));
    expect(toMarkdown(report)).toContain("2 claim(s) dropped by the quote guard");
  });

  it("links file evidence at the line and the head SHA", () => {
    const result = makeClaimResult("VERIFIED", {
      evidence: [
        {
          type: "file",
          path: "src/app.ts",
          line: 12,
          checkRunName: null,
          detail: null,
          url: "https://github.com/acme/widget/blob/deadbeef/src/app.ts#L12",
        },
      ],
    });
    const report = buildReport(baseInput([result]));
    const markdown = toMarkdown(report);
    expect(markdown).toContain("src/app.ts#L12");
    expect(markdown).toContain("https://github.com/acme/widget/blob/deadbeef/src/app.ts#L12");
  });
});
