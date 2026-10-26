/**
 * GitHub access: parse a PR URL, fetch the full PR bundle via Octokit
 * (title/body/author/head SHA, files + patches, commit messages, check runs
 * and legacy combined status for the head SHA), and turn GitHub's failure
 * modes into clear, user-facing errors.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import { enrichChangedFiles } from "./diff";
import type { CheckRun, PrBundle } from "./types";

/** Minimal description of a PR location, produced by parsePrUrl(). */
export interface PrLocator {
  owner: string;
  repo: string;
  number: number;
}

/** Hard caps so one huge PR can't blow up the run (docs/PLAN.md §16). */
export const MAX_FILES = 100;
export const MAX_COMMITS = 50;

/** Error with a user-facing message; `status` carries the GitHub status when known. */
export class GitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/**
 * Parses a GitHub pull-request URL: `github.com/o/r/pull/N`, with or without
 * a scheme, and tolerated trailing path (`/files`, `/commits`) or query
 * (`?diff=split`). Throws GitHubError for anything else.
 */
export function parsePrUrl(input: string): PrLocator {
  const normalized = input.trim();
  const match = normalized.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (!match) {
    throw new GitHubError(
      `"${input}" is not a GitHub pull-request URL. Expected: https://github.com/<owner>/<repo>/pull/<number>`,
    );
  }
  const number = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GitHubError(`Invalid pull-request number in "${input}".`);
  }
  return { owner: match[1], repo: match[2], number };
}

interface OctokitLikeError {
  status?: number;
  response?: { headers?: Record<string, string> };
}

function isOctokitError(error: unknown): error is OctokitLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    ("status" in error || "response" in error)
  );
}

/** Extracts `x-ratelimit-reset` (unix seconds) from an Octokit error, if present. */
function rateLimitReset(error: unknown): number | null {
  if (!isOctokitError(error)) return null;
  const headers = error.response?.headers;
  const reset = headers?.["x-ratelimit-reset"];
  if (reset !== undefined) {
    const seconds = Number.parseInt(reset, 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return null;
}

/** Turns any GitHub failure into a GitHubError with an actionable message. */
function toGitHubError(error: unknown, context: string): GitHubError {
  if (error instanceof GitHubError) return error;
  const status = isOctokitError(error) && typeof error.status === "number" ? error.status : undefined;

  if (status === 404) {
    return new GitHubError(
      `${context}: not found. The PR may not exist, or the repository is private ` +
        "(Receipts only supports public repos; a read-only GITHUB_TOKEN raises the rate limit but not repo visibility).",
      status,
    );
  }
  if (status === 401) {
    return new GitHubError(
      `${context}: GitHub rejected the token (401). Check that GITHUB_TOKEN is a valid, non-expired token.`,
      status,
    );
  }
  if (status === 403 || status === 429) {
    const reset = rateLimitReset(error);
    const resetText = reset ? ` Rate limit resets at ${new Date(reset * 1000).toISOString()}.` : "";
    return new GitHubError(
      `${context}: GitHub API rate limit exhausted (${status}).${resetText} ` +
        "Add a read-only GITHUB_TOKEN (5,000 req/h) to raise the limit — anonymous is 60 req/h.",
      status,
    );
  }
  if (status !== undefined && status >= 500) {
    return new GitHubError(`${context}: GitHub server error (HTTP ${status}). Try again shortly.`, status);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new GitHubError(`${context}: ${detail}`, status);
}

type RawFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];
type RawCommit = RestEndpointMethodTypes["pulls"]["listCommits"]["response"]["data"][number];
type RawCheckRun = RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"][number];
type RawStatus = RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"];

/**
 * Sanitizes a PR body for use as claim-extraction source text (Bug 4):
 *
 * 1. Removes paired bot comment blocks, e.g. Greptile's
 *    `<!-- greptile_comment --> … <!-- /greptile_comment -->` — AI-reviewer
 *    output must never leak into claims or the judge's untrusted data.
 * 2. Removes remaining HTML comments, markdown badge chains, `<picture>`
 *    blocks and `<img>` tags.
 * 3. Strips other HTML tags (`<details>`, `<sub>`, anchors) but keeps their
 *    inner text, then collapses excessive whitespace (line runs and
 *    trailing spaces per line).
 *
 * The quote guard compares against the SANITIZED text, so quotes pulled
 * from bot comments or image markup can never validate.
 */
export function sanitizePrBody(body: string | null): string | null {
  if (body === null) return null;
  let text = body;
  // 1. Paired named comment blocks: <!-- name --> ... <!-- /name -->
  text = text.replace(/<!--\s*([a-zA-Z0-9_.-]+)\s*-->[\s\S]*?<!--\s*\/\1\s*-->/g, "");
  // 2a. Any remaining HTML comments (paired or orphaned).
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // 2b. Markdown badges: [![alt](img)](link) and standalone ![alt](img).
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 2c. <picture> blocks and <img> tags carry no text worth quoting.
  text = text.replace(/<picture>[\s\S]*?<\/picture>/gi, "");
  text = text.replace(/<img\b[^>]*\/?>/gi, "");
  // 3. Strip remaining HTML tags, keeping inner text.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // 4. Collapse whitespace: trailing spaces per line, 3+ newlines -> 2.
  text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function createOctokit(githubToken: string | undefined): Octokit {
  return new Octokit({
    ...(githubToken ? { auth: githubToken } : {}),
    userAgent: "receipts",
  });
}

/**
 * Fetches everything the engine needs about one PR and returns a validated,
 * enriched PrBundle. `input` is a PR URL or a locator; `githubToken` is
 * optional (raises the rate limit from 60 to 5,000 requests/hour).
 *
 * File list is capped at MAX_FILES (100) and commits at MAX_COMMITS (50);
 * the corresponding `*Truncated` flags record when the cap was hit.
 */
export async function fetchPrBundle(
  input: string | PrLocator,
  options: { githubToken?: string } = {},
): Promise<PrBundle> {
  const locator = typeof input === "string" ? parsePrUrl(input) : input;
  const { owner, repo, number } = locator;
  const octokit = createOctokit(options.githubToken);
  const context = `${owner}/${repo}#${number}`;

  let pull: RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];
  try {
    const response = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    pull = response.data;
  } catch (error) {
    throw toGitHubError(error, `Fetching PR ${context}`);
  }

  const headSha = pull.head?.sha;
  const prUrl = pull.html_url;
  if (typeof headSha !== "string" || typeof prUrl !== "string") {
    throw new GitHubError(`PR ${context}: GitHub returned no head SHA or URL.`);
  }

  // --- changed files (paginated, capped) ---
  const rawFiles: RawFile[] = [];
  let filesTruncated = false;
  try {
    for (let page = 1; rawFiles.length < MAX_FILES; page++) {
      const response = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
        page,
      });
      rawFiles.push(...response.data);
      if (response.data.length === 0) break;
      if (rawFiles.length > MAX_FILES) {
        rawFiles.length = MAX_FILES;
        filesTruncated = true;
        break;
      }
    }
  } catch (error) {
    throw toGitHubError(error, `Fetching files for ${context}`);
  }

  // --- commits (paginated, capped) ---
  const rawCommits: RawCommit[] = [];
  let commitsTruncated = false;
  try {
    for (let page = 1; rawCommits.length < MAX_COMMITS; page++) {
      const response = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: number,
        per_page: MAX_COMMITS,
        page,
      });
      rawCommits.push(...response.data);
      if (response.data.length === 0) break;
      if (rawCommits.length >= MAX_COMMITS) {
        // This page filled the cap; additional pages would be dropped anyway.
        commitsTruncated = rawCommits.length >= MAX_COMMITS;
        break;
      }
    }
  } catch (error) {
    throw toGitHubError(error, `Fetching commits for ${context}`);
  }

  // --- CI: check runs for head SHA (404 = repo has no check runs yet) ---
  let checkRuns: CheckRun[] = [];
  try {
    const response = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });
    checkRuns = response.data.check_runs.map((run: RawCheckRun) => ({
      name: run.name ?? "(unnamed check)",
      status: run.status ?? "completed",
      conclusion: run.conclusion ?? null,
      htmlUrl: run.html_url ?? prUrl,
    }));
  } catch (error) {
    const status = isOctokitError(error) && typeof error.status === "number" ? error.status : undefined;
    if (status !== 404) {
      throw toGitHubError(error, `Fetching check runs for ${context}`);
    }
  }

  // --- CI: legacy combined status for head SHA (404 = no statuses) ---
  let combinedStatus: PrBundle["combinedStatus"] = null;
  try {
    const response = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });
    const data: RawStatus = response.data;
    combinedStatus = {
      state: data.state ?? null,
      statuses: data.statuses.map((status) => ({
        context: status.context ?? "(unknown context)",
        state: status.state ?? "pending",
        targetUrl: status.target_url ?? null,
      })),
    };
  } catch (error) {
    const status = isOctokitError(error) && typeof error.status === "number" ? error.status : undefined;
    if (status !== 404) {
      throw toGitHubError(error, `Fetching commit status for ${context}`);
    }
  }

  const bundle: PrBundle = {
    prUrl,
    owner,
    repo,
    number,
    title: pull.title ?? "",
    // Sanitized at fetch time (Bug 4): bot comment blocks, HTML comments,
    // badges, and markup are removed before claims are extracted — so
    // fixtures and the quote guard agree on one canonical body text.
    body: sanitizePrBody(pull.body ?? null),
    author: pull.user?.login ?? "(unknown)",
    headSha,
    files: enrichChangedFiles(
      rawFiles.map((file) => ({
        path: file.filename,
        previousPath: file.previous_filename ?? null,
        status: file.status ?? "modified",
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        patch: file.patch ?? null,
      })),
    ),
    commits: rawCommits.map((commit) => ({
      sha: commit.sha,
      message: (commit.commit?.message ?? "").split("\n", 1)[0] ?? "",
    })),
    checkRuns,
    combinedStatus,
    fetchedAt: new Date().toISOString(),
    filesTruncated,
    commitsTruncated,
  };
  return bundle;
}
