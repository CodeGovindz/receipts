---
name: receipts-verify
description: Check that what a pull request says it does matches its real diff and CI. Use after opening or updating a pull request, before writing or editing a PR description, and when reviewing someone else's (or another agent's) PR that claims "added tests", "all tests pass", "no breaking changes" or similar.
---

# Receipts: every claim, with a receipt

The Receipts MCP server checks claims about a GitHub pull request against the PR's actual diff, changed test files and CI checks. Hosts prefix tool names (in Alan: `receipts_receipts__verify_pr` and `receipts_receipts__check_claims`); the names below are the upstream ones.

Each claim comes back as:

- **VERIFIED**: the diff or CI supports it, with links to the lines or checks.
- **CONTRADICTED**: the evidence shows it is false, with links.
- **UNVERIFIED**: nothing checkable supports or refutes it (for example "tests pass locally", or CI skipped the test jobs).

The PR gets **PASS** (all verified), **FAIL** (anything contradicted) or **MIXED**.

## Before you write a PR description

1. Push the branch and open the PR (a short placeholder description is fine).
2. Call `check_claims` with the `pr_url` and the statements you plan to make, one per item, for example `["Adds tests for the login timeout", "All tests pass in CI", "No public API changes"]`.
3. Drop or rewrite every CONTRADICTED claim. For each UNVERIFIED one, either make it checkable (add the test, wait for CI) or say plainly in the description that it is unverified and why.
4. Write the final description from what survived.

## After you open or update a PR

1. Call `verify_pr` with the `pr_url`. Pass `fresh: true` after pushing new commits.
2. If the grade is **FAIL**, fix the code or correct the description, push, and run `verify_pr` again with `fresh: true`.
3. Stop when the grade is PASS, or MIXED with every UNVERIFIED item explained in the description.
4. Post the markdown from the first content block as a PR comment with your GitHub tools, and attach it to the task as testing evidence. Its first line is the marker `<!-- receipts:report -->`; if an earlier Receipts comment exists, update it instead of adding another.

## Reviewing someone else's PR

Run `verify_pr` and lead your review with the CONTRADICTED items, then the UNVERIFIED ones. Quote the evidence links instead of re-deriving them.

## Rules

- Never claim a check passed because Receipts said UNVERIFIED. Unverified means nobody has shown it yet.
- A run takes 10 to 60 seconds. Don't call it in a loop without pushing changes in between.
- Only public GitHub repositories are supported. If the tool errors (rate limit, private repo), say so instead of guessing the verdicts.
