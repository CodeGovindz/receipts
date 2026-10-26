/**
 * Regression eval for the Receipts engine (runs after the P1 precision
 * fixes): re-runs the pipeline against every recorded real-PR fixture
 * (fixtures/real-*.json — no GitHub calls; the Bedrock models run live)
 * and checks each run against the expectations in fixtures/expectations.json.
 *
 * Prints a pass/fail table + timing/attempt summary, and exits non-zero when
 * any expectation fails. Run: npm run eval.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { getConfig, loadDotEnv } from "../src/core/env";
import { classifyCheckName, type CheckKind } from "../src/core/signals";
import { runReceiptsOnBundle, type PipelineEvent } from "../src/core/pipeline";
import {
  ClaimCategorySchema,
  GradeSchema,
  PrBundleSchema,
  VerdictSchema,
  type Report,
} from "../src/core/types";

const CheckKindSchema = z.enum(["test", "lint", "typecheck", "build", "deploy", "bot", "other"]);

/** One eval expectation — a tiny DSL, validated with zod before use. */
const ExpectationSchema = z.discriminatedUnion("type", [
  z.object({
    /** Every claim whose `text` contains textIncludes (case-insensitive) must have this verdict. */
    type: z.literal("claimVerdict"),
    textIncludes: z.string(),
    verdict: VerdictSchema,
    /** required: the run FAILS if no claim matches. Otherwise vacuous pass. */
    required: z.boolean().default(false),
  }),
  z.object({
    /** NO claim whose `text` contains textIncludes (case-insensitive) may have this verdict. Empty string = every claim. */
    type: z.literal("noClaimVerdict"),
    textIncludes: z.string(),
    verdict: VerdictSchema,
  }),
  z.object({ type: z.literal("gradeIs"), grade: GradeSchema }),
  z.object({ type: z.literal("gradeIsNot"), grade: GradeSchema }),
  z.object({
    /** Every CONTRADICTED claim of claimCategory must cite >=1 check run classified as `kind`. */
    type: z.literal("contradictedMustCiteKind"),
    claimCategory: ClaimCategorySchema,
    kind: CheckKindSchema,
  }),
]);

const ExpectationsFileSchema = z.record(
  z.string(),
  z.object({
    url: z.string(),
    expectations: z.array(ExpectationSchema),
  }),
);

type Expectation = z.infer<typeof ExpectationSchema>;

interface ExpectationResult {
  description: string;
  pass: boolean;
  detail: string;
}

function claimsMatching(report: Report, textIncludes: string): number[] {
  const needle = textIncludes.toLowerCase();
  return report.claims
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.claim.text.toLowerCase().includes(needle))
    .map(({ index }) => index);
}

function describeClaim(result: Report["claims"][number]): string {
  return `"${result.claim.text.slice(0, 60)}" -> ${result.verdict}`;
}

function evaluateExpectation(expectation: Expectation, report: Report): ExpectationResult {
  switch (expectation.type) {
    case "claimVerdict": {
      const matches = claimsMatching(report, expectation.textIncludes);
      if (matches.length === 0) {
        return {
          description: `claim with text ~= "${expectation.textIncludes}" is ${expectation.verdict}`,
          pass: !expectation.required,
          detail: expectation.required
            ? "FAILED: no matching claim was extracted"
            : "vacuous pass: claim not extracted",
        };
      }
      const failures = matches
        .filter((index) => report.claims[index].verdict !== expectation.verdict)
        .map((index) => describeClaim(report.claims[index]));
      return {
        description: `claim with text ~= "${expectation.textIncludes}" is ${expectation.verdict}`,
        pass: failures.length === 0,
        detail:
          failures.length === 0
            ? `${matches.length} matching claim(s) hold the verdict`
            : `FAILED: ${failures.join("; ")}`,
      };
    }
    case "noClaimVerdict": {
      const matches = claimsMatching(report, expectation.textIncludes);
      const offenders = matches
        .filter((index) => report.claims[index].verdict === expectation.verdict)
        .map((index) => describeClaim(report.claims[index]));
      return {
        description:
          expectation.textIncludes === ""
            ? `NO claim at all is ${expectation.verdict}`
            : `no claim with text ~= "${expectation.textIncludes}" is ${expectation.verdict}`,
        pass: offenders.length === 0,
        detail:
          offenders.length === 0
            ? `${matches.length} claim(s) checked, none ${expectation.verdict}`
            : `FAILED: ${offenders.join("; ")}`,
      };
    }
    case "gradeIs":
      return {
        description: `grade is ${expectation.grade}`,
        pass: report.grade === expectation.grade,
        detail: report.grade === expectation.grade ? "ok" : `FAILED: got ${report.grade}`,
      };
    case "gradeIsNot":
      return {
        description: `grade is NOT ${expectation.grade}`,
        pass: report.grade !== expectation.grade,
        detail: report.grade !== expectation.grade ? `got ${report.grade}` : "FAILED",
      };
    case "contradictedMustCiteKind": {
      const contradictions = report.claims.filter(
        (result) => result.verdict === "CONTRADICTED" && result.claim.category === expectation.claimCategory,
      );
      const offenders: string[] = [];
      for (const result of contradictions) {
        const citedKinds = result.evidence
          .filter((item) => item.type === "check_run" && item.checkRunName !== null)
          .map((item) => classifyCheckName(item.checkRunName ?? ""));
        const ok = citedKinds.some((kind: CheckKind) => kind === expectation.kind);
        if (!ok) {
          offenders.push(
            `"${result.claim.text.slice(0, 60)}" cites check kinds [${citedKinds.join(", ") || "none"}], needs "${expectation.kind}"`,
          );
        }
      }
      return {
        description: `every CONTRADICTED ${expectation.claimCategory} claim cites a "${expectation.kind}" check`,
        pass: offenders.length === 0,
        detail:
          contradictions.length === 0
            ? "vacuous: no such contradictions"
            : offenders.length === 0
              ? `${contradictions.length} contradiction(s) all cite the right kind`
              : `FAILED: ${offenders.join("; ")}`,
      };
    }
  }
}

interface FixtureResult {
  name: string;
  url: string;
  report: Report;
  results: ExpectationResult[];
  runtimeSeconds: number;
  error: string | null;
}

async function runFixture(
  name: string,
  url: string,
  expectations: Expectation[],
  config: Parameters<typeof runReceiptsOnBundle>[1]["config"],
): Promise<FixtureResult> {
  const fixturePath = path.join(process.cwd(), "fixtures", `${name}.json`);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture ${fixturePath} is missing`);
  }
  const bundle = PrBundleSchema.parse(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
  const started = Date.now();
  const quietEvents = (event: PipelineEvent): void => {
    if (event.type === "fallback") {
      console.log(`  ⚠ fallback on claim ${event.index}/${event.total}: ${event.reason}`);
    }
  };
  const report = await runReceiptsOnBundle(bundle, { config, onEvent: quietEvents, fresh: true });
  const runtimeSeconds = (Date.now() - started) / 1000;
  return {
    name,
    url,
    report,
    results: expectations.map((expectation) => evaluateExpectation(expectation, report)),
    runtimeSeconds,
    error: null,
  };
}

function main(): Promise<void> {
  loadDotEnv();
  const config = getConfig();
  const expectationsPath = path.join(process.cwd(), "fixtures", "expectations.json");
  const rawJson: Record<string, unknown> = JSON.parse(fs.readFileSync(expectationsPath, "utf8"));
  // Drop documentation keys ("$comment") before validating the records.
  for (const key of Object.keys(rawJson)) {
    if (key.startsWith("$")) delete rawJson[key];
  }
  const parsed = ExpectationsFileSchema.parse(rawJson);

  const names = Object.keys(parsed).sort();
  const finished: FixtureResult[] = [];
  const errored: Array<{ name: string; error: string }> = [];

  const queue = [...names];
  // Sequential: the verify stage already runs claims at concurrency 4 inside
  // each fixture; two fixtures in parallel would double Bedrock pressure.
  return (async (): Promise<void> => {
    for (const name of queue) {
      const entry = parsed[name];
      console.log(`▶ ${name} (${entry.url})`);
      try {
        const result = await runFixture(name, entry.url, entry.expectations, config);
        finished.push(result);
        for (const expectation of result.results) {
          const badge = expectation.pass ? "✓" : "✗";
          console.log(
            `  ${badge} ${expectation.pass ? "pass" : "FAIL"} — ${expectation.description}: ${expectation.detail}`,
          );
        }
      } catch (error) {
        errored.push({ name, error: error instanceof Error ? error.message : String(error) });
        console.log(`  ✗ RUN FAILED — ${errored[errored.length - 1].error}`);
      }
    }

    // Summary table.
    const passedChecks = finished.reduce((sum, fixture) => sum + fixture.results.filter((r) => r.pass).length, 0);
    const totalChecks = finished.reduce((sum, fixture) => sum + fixture.results.length, 0);
    console.log("\nfixture                     grade  trust  runtime  extract-attempts  verdict");
    for (const fixture of finished) {
      const allPass = fixture.results.every((result) => result.pass);
      const trust = fixture.report.trustScore === null ? "—" : `${Math.round(fixture.report.trustScore * 100)}%`;
      console.log(
        `${fixture.name.padEnd(26)} ${fixture.report.grade.padEnd(6)} ${trust.padEnd(6)} ` +
          `${fixture.runtimeSeconds.toFixed(1)}s`.padEnd(9) +
          `${fixture.report.timings.extractAttempts}`.padEnd(17) +
          `${allPass ? "PASS" : "FAIL"} (${fixture.results.filter((r) => r.pass).length}/${fixture.results.length})`,
      );
    }
    const totalSeconds = finished.reduce((sum, fixture) => sum + fixture.runtimeSeconds, 0);
    const anyFailed =
      errored.length > 0 ||
      finished.some((fixture) => fixture.results.some((result) => !result.pass));
    console.log(
      `\n${names.length - errored.length}/${names.length} fixtures ran · ${passedChecks}/${totalChecks} expectations passed · ${totalSeconds.toFixed(1)}s total`,
    );
    if (anyFailed) process.exit(1);
  })();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
