# Receipts

**Every agent claim, with a receipt.**

Receipts audits pull-request descriptions the way a reviewer wishes they could: it extracts every factual claim an agent makes ("fixed the login bug", "added tests", "all checks pass"), checks each one against the real diff, test files, and CI results on GitHub, and returns a verdict — VERIFIED, CONTRADICTED, or UNVERIFIED — with a citation for every call it makes.

- **PASS** — every claim verified. **FAIL** — any claim contradicted. **MIXED** — the rest, with a trust score (`verified / total`).

**Status: work in progress.** The scaffold (P0) is in place; the core engine, web UI, MCP server, and Alan plugin land in the next phases. The full build plan lives in [`docs/PLAN.md`](docs/PLAN.md).
