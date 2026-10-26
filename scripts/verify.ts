/**
 * Receipts CLI (P0 placeholder).
 *
 * Target contract (lands in P1): `npx tsx scripts/verify.ts <pr-url> [--json]`
 * runs the full pipeline against a public GitHub PR and prints the report
 * (markdown by default, JSON with --json).
 */

function main(): void {
  const prUrl = process.argv[2];
  if (!prUrl || prUrl.startsWith("-")) {
    console.error("Usage: npm run verify -- <pr-url> [--json]");
    process.exit(1);
  }
  console.error(
    "Not implemented yet — the verify CLI lands in P1 (see docs/PLAN.md). " +
      "Nothing was run.",
  );
  process.exit(1);
}

main();
