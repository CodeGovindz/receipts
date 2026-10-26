/**
 * Receipts as an MCP server (plan §10/§11). Two read-only tools:
 * - verify_pr: check every claim in an existing PR.
 * - check_claims: check claims an agent is about to write, before it writes them.
 * Each result carries the GitHub-comment-ready markdown plus a compact JSON
 * summary. The server has no GitHub write access: agents post the markdown
 * with their own GitHub tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_DRAFT_CLAIMS, runClaimCheck, runReceipts } from "@/core/pipeline";
import { toMarkdown } from "@/core/report";
import type { Report } from "@/core/types";
import { takeRun } from "@/lib/ratelimit";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** The fields an agent acts on, without the full report's timings and quotes. */
function summarize(report: Report) {
  return {
    prUrl: report.prUrl,
    headSha: report.headSha,
    grade: report.grade,
    trustScore: report.trustScore,
    claims: report.claims.map((result) => ({
      claim: result.claim.text,
      verdict: result.verdict,
      reasoning: result.reasoning,
      evidence: result.evidence.map((item) => item.url).filter((url): url is string => url !== null),
    })),
    signals: report.signals,
  };
}

function success(report: Report): ToolResult {
  return {
    content: [
      { type: "text", text: toMarkdown(report) },
      { type: "text", text: JSON.stringify(summarize(report)) },
    ],
  };
}

function failure(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Receipts failed: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

/** One server per request (stateless transport); `clientKey` rate-limits tool calls. */
export function createReceiptsMcpServer(clientKey: string): McpServer {
  const server = new McpServer({ name: "receipts", version: "1.0.0" });

  const limited = (): ToolResult | null => {
    const limit = takeRun(clientKey);
    if (limit.ok) return null;
    return failure(
      new Error(`rate limit reached (10 runs per hour); retry in ${Math.ceil(limit.retryAfterSec / 60)} min.`),
    );
  };

  server.registerTool(
    "verify_pr",
    {
      title: "Verify a pull request's claims",
      description:
        "Extracts every checkable claim from a GitHub pull request's title, description and commits " +
        "(\"added tests\", \"all tests pass\", \"no breaking changes\"…) and checks each one against the " +
        "real diff and CI. Each claim gets VERIFIED, CONTRADICTED or UNVERIFIED with evidence links; the " +
        "PR gets PASS (all verified), FAIL (any contradicted) or MIXED. Takes 10-60 s. Returns a " +
        "markdown report ready to post as a PR comment, then a JSON summary.",
      inputSchema: {
        pr_url: z.string().describe("Public GitHub PR URL, e.g. https://github.com/owner/repo/pull/123"),
        fresh: z.boolean().optional().describe("Skip the cache and re-check (e.g. after pushing fixes)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pr_url, fresh }) => {
      const blocked = limited();
      if (blocked) return blocked;
      try {
        return success(await runReceipts(pr_url, { fresh }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_claims",
    {
      title: "Check claims before writing them",
      description:
        "Checks claims you are ABOUT to make about a pull request (for example the bullet points of a " +
        "PR description you are drafting) against its real diff and CI, before you post them. Use it " +
        "to avoid over-claiming: rewrite or drop anything CONTRADICTED, and say plainly what stays " +
        "UNVERIFIED. The PR must already exist (push the branch and open it first).",
      inputSchema: {
        pr_url: z.string().describe("Public GitHub PR URL the claims are about."),
        claims: z
          .array(z.string())
          .min(1)
          .max(MAX_DRAFT_CLAIMS)
          .describe(`1-${MAX_DRAFT_CLAIMS} claims, one statement each, e.g. "Adds tests for the login timeout".`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pr_url, claims }) => {
      const blocked = limited();
      if (blocked) return blocked;
      try {
        return success(await runClaimCheck(pr_url, claims));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
