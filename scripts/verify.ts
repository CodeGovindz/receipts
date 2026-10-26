/**
 * Receipts CLI (P1).
 *
 * npm run verify -- <pr-url> [--json] [--fresh] [--dump-fixture <name>]
 *
 * Progress events stream to stderr; the markdown report (or JSON with
 * --json) goes to stdout, followed by a timing/token summary on stderr.
 * --dump-fixture saves the fetched+enriched PrBundle to fixtures/<name>.json
 * for offline tests and a reliable demo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadDotEnv } from "../src/core/env";
import { runReceipts, type PipelineEvent } from "../src/core/pipeline";
import { toJSON, toMarkdown } from "../src/core/report";
import type { PrBundle } from "../src/core/types";

interface CliOptions {
  prUrl: string;
  json: boolean;
  fresh: boolean;
  fixtureName: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { prUrl: "", json: false, fresh: false, fixtureName: null };
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
    } else {
      positional.push(arg);
    }
  }
  options.prUrl = positional[0] ?? "";
  return options;
}

function usage(): never {
  console.error("Usage: npm run verify -- <pr-url> [--json] [--fresh] [--dump-fixture <name>]");
  process.exit(1);
}

function truncate(text: string, length: number): string {
  const cleaned = text.replace(/\s+/g, " ");
  return cleaned.length > length ? `${cleaned.slice(0, length - 1)}…` : cleaned;
}

/** Renders one progress event as a log line. */
function eventLine(event: PipelineEvent): string {
  switch (event.type) {
    case "fetching":
      return "→ fetching PR…";
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.prUrl === "") usage();
  if (options.prUrl.startsWith("-")) usage();
  loadDotEnv();

  let dumpedFixture: string | null = null;
  const dumpFixture = (bundle: PrBundle): void => {
    if (options.fixtureName === null) return;
    const fixturesDir = path.join(process.cwd(), "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    const file = path.join(fixturesDir, `${options.fixtureName}.json`);
    fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    dumpedFixture = file;
  };

  const report = await runReceipts(options.prUrl, {
    fresh: options.fresh,
    onEvent: (event) => {
      if (event.type === "extracted" && event.error !== null) {
        console.error(`✗ ${event.error}`);
      }
      const line = eventLine(event);
      if (line !== "") console.error(line);
    },
    onBundle: dumpFixture,
  });

  // Timing/token summary (stderr; stdout stays pure report for piping).
  const timings = report.timings;
  console.error(
    `⏱ ${(timings.totalMs / 1000).toFixed(1)}s total · fetch ${(
      timings.fetchMs / 1000
    ).toFixed(1)}s · extract ${(timings.extractMs / 1000).toFixed(1)}s · verify ${(
      timings.verifyMs / 1000
    ).toFixed(1)}s · ${timings.llmCalls} LLM call(s) · tokens in ${timings.inputTokens} / out ${timings.outputTokens}`,
  );
  if (dumpedFixture !== null) {
    console.error(`📦 fixture saved: ${dumpedFixture}`);
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
