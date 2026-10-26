/**
 * Receipts CLI (P1).
 *
 * npm run verify -- <pr-url> [--json] [--fresh] [--dump-fixture <name>]
 *   or: npx tsx scripts/verify.ts <pr-url> --json --fresh --dump-fixture <name>
 *
 * --fixture <path> runs the pipeline on a saved PrBundle JSON (fixtures
 * folder) instead of fetching from GitHub — no network calls to GitHub; the
 * Bedrock models still run live. Useful to re-run the exact bundle a real
 * PR produced (offline from GitHub), and as the base of the eval suite.
 *
 * Progress events stream to stderr; the markdown report (or JSON with
 * --json) goes to stdout, followed by a timing/token summary on stderr.
 * --dump-fixture saves the fetched+enriched PrBundle to fixtures/<name>.json
 * for offline tests and a reliable demo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig, loadDotEnv } from "../src/core/env";
import { runReceipts, runReceiptsOnBundle, type PipelineEvent } from "../src/core/pipeline";
import { toJSON, toMarkdown } from "../src/core/report";
import { PrBundleSchema, type PrBundle, type Report } from "../src/core/types";

interface CliOptions {
  prUrl: string;
  json: boolean;
  fresh: boolean;
  fixtureName: string | null;
  fixturePath: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    prUrl: "",
    json: false,
    fresh: false,
    fixtureName: null,
    fixturePath: null,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fresh") {
      options.fresh = true;
    } else if (arg === "--dump-fixture") {
      const name = argv[index + 1];
      if (!name || name.startsWith("--")) {
        console.error("--dump-fixture requires a fixture name, e.g. --dump-fixture my-pr");
        process.exit(1);
      }
      options.fixtureName = name;
      index++;
    } else if (arg === "--fixture") {
      const fixture = argv[index + 1];
      if (!fixture || fixture.startsWith("--")) {
        console.error("--fixture requires a path to a saved PrBundle JSON file");
        process.exit(1);
      }
      options.fixturePath = fixture;
      index++;
    } else {
      positional.push(arg);
    }
  }
  options.prUrl = positional[0] ?? "";
  return options;
}

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/verify.ts <pr-url> [--json] [--fresh] [--dump-fixture <name>]\n" +
      "       npx tsx scripts/verify.ts --fixture <path-to-bundle.json> [--json] [--fresh]",
  );
  process.exit(1);
}

function truncate(text: string, length: number): string {
  const cleaned = text.replace(/\s+/g, " ");
  return cleaned.length > length ? `${cleaned.slice(0, length - 1)}…` : cleaned;
}

/** Renders one progress event as a log line. */
function eventLine(event: PipelineEvent, fixtureMode: boolean): string {
  switch (event.type) {
    case "fetching":
      return fixtureMode ? "→ fixture mode: skipping GitHub fetch" : "→ fetching PR…";
    case "fetched":
      return `✓ ${truncate(event.title, 70)} · ${event.filesChanged} file(s) · ${event.checkRuns} check run(s)`;
    case "extracting":
      return "→ extracting claims…";
    case "extracted": {
      const dropped = event.dropped > 0 ? ` (${event.dropped} dropped by quote guard)` : "";
      return `✓ ${event.total} claim(s) extracted${dropped}`;
    }
    case "verifying":
      return `→ verifying ${event.index}/${event.total}: ${truncate(event.claim, 80)}`;
    case "fallback":
      return `⚠ claim ${event.index}/${event.total}: STRONG ${event.reason} → falling back to FALLBACK model`;
    case "done":
      return event.report.cached ? "✓ report restored from cache" : "✓ done";
    case "error":
      return `✗ ${event.error}`;
  }
}

function printSummary(report: Report, extra: string | null): void {
  const timings = report.timings;
  const retryNote = (attempts: number) => (attempts > 1 ? ` ${attempts} attempts (incl. retry)` : " 1 attempt");
  console.error(
    `⏱ ${(timings.totalMs / 1000).toFixed(1)}s total · fetch ${(timings.fetchMs / 1000).toFixed(1)}s · ` +
      `extract ${(timings.extractMs / 1000).toFixed(1)}s${retryNote(timings.extractAttempts)} · ` +
      `verify ${(timings.verifyMs / 1000).toFixed(1)}s · ${timings.verifyAttempts} model attempt(s) across claims · ` +
      `${timings.llmCalls} LLM call(s) · tokens in ${timings.inputTokens} / out ${timings.outputTokens}` +
      (extra !== null ? `\n${extra}` : ""),
  );
}

/** Loads and zod-validates a saved PrBundle. */
function loadFixtureBundle(fixturePath: string): PrBundle {
  let raw: string;
  try {
    raw = fs.readFileSync(fixturePath, "utf8");
  } catch (error) {
    console.error(
      `Cannot read fixture "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  try {
    return PrBundleSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.error(
      `Fixture "${fixturePath}" is not a valid PrBundle: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.fixturePath === null && (options.prUrl === "" || options.prUrl.startsWith("-"))) {
    usage();
  }
  loadDotEnv();
  const config = getConfig();
  const onEvent = (event: PipelineEvent): void => {
    if (event.type === "extracted" && event.error !== null) {
      console.error(`✗ ${event.error}`);
    }
    const line = eventLine(event, options.fixturePath !== null);
    if (line !== "") console.error(line);
  };

  let report: Report;
  if (options.fixturePath !== null) {
    // Fixture mode: the bundle is pinned; GitHub is not touched. --fresh
    // bypasses the in-memory cache so the pinned bundle is fully re-run.
    const bundle = loadFixtureBundle(options.fixturePath);
    console.error(
      `▶ fixture: ${bundle.prUrl} @ ${bundle.headSha.slice(0, 7)} (${bundle.files.length} file(s), ` +
        `${bundle.checkRuns.length} check run(s), captured ${bundle.fetchedAt})`,
    );
    report = await runReceiptsOnBundle(bundle, {
      config,
      onEvent,
      fresh: options.fresh,
    });
    printSummary(report, null);
  } else {
    let dumpedFixture: string | null = null;
    const reportPromise = runReceipts(options.prUrl, {
      fresh: options.fresh,
      onEvent,
      onBundle: (bundle) => {
        if (options.fixtureName === null) return;
        const fixturesDir = path.join(process.cwd(), "fixtures");
        fs.mkdirSync(fixturesDir, { recursive: true });
        const file = path.join(fixturesDir, `${options.fixtureName}.json`);
        fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
        dumpedFixture = file;
      },
    });
    report = await reportPromise;
    printSummary(report, dumpedFixture !== null ? `📦 fixture saved: ${dumpedFixture}` : null);
  }

  if (options.json) {
    console.log(toJSON(report));
  } else {
    console.log(toMarkdown(report));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
