/**
 * Report building: grade, trust score, modelsUsed aggregation, and the
 * GitHub-comment-ready markdown rendering. The models footer is derived
 * ONLY from report data (modelsUsed) — never from env vars — so it always
 * reflects what actually produced the verdicts (plan §1).
 *
 * This module must stay framework-free: no Next.js imports.
 */
import type { ClaimResult, Grade, ModelsUsed, Report } from "./types";
import { ReportSchema } from "./types";

/** Grading truth table (plan §1): any CONTRADICTED -> FAIL; all VERIFIED -> PASS; otherwise MIXED. Zero claims -> MIXED. */
export function computeGrade(results: ReadonlyArray<Pick<ClaimResult, "verdict">>): Grade {
  if (results.length === 0) return "MIXED";
  if (results.some((result) => result.verdict === "CONTRADICTED")) return "FAIL";
  if (results.every((result) => result.verdict === "VERIFIED")) return "PASS";
  return "MIXED";
}

/** Trust score = verified / total; null when there are no claims (rendered "—"). */
export function computeTrustScore(results: ReadonlyArray<Pick<ClaimResult, "verdict">>): number | null {
  if (results.length === 0) return null;
  const verified = results.filter((result) => result.verdict === "VERIFIED").length;
  return Math.round((verified / results.length) * 100) / 100;
}

/** Friendly display names for the models actually used (sourced from report data). */
export function friendlyModelName(modelId: string): string {
  const known: Record<string, string> = {
    "qwen.qwen3-coder-next": "Qwen3 Coder Next",
    "us.moonshotai.kimi-k3": "Kimi K3",
    "moonshotai.kimi-k3": "Kimi K3",
    "openai.gpt-oss-120b-1:0": "GPT-OSS 120B",
    "openai.gpt-oss-120b": "GPT-OSS 120B",
  };
  return known[modelId] ?? modelId;
}

/** "Verdicts" half of the footer, e.g. "Kimi K3 (2 via GPT-OSS 120B)". */
function verdictsText(models: ModelsUsed): string {
  const all = models.verdictsModels.map(friendlyModelName);
  const fallbackName = models.fallbackModel ? friendlyModelName(models.fallbackModel) : null;
  if (all.length === 0) return "—";
  if (fallbackName !== null && models.fallbackCount > 0) {
    const withoutFallback = all.filter((name) => name !== fallbackName);
    if (withoutFallback.length === 0) return fallbackName;
    return `${withoutFallback.join(", ")} (${models.fallbackCount} via ${fallbackName})`;
  }
  return all.join(", ");
}

/** The footer line required by the plan, sourced entirely from modelsUsed. */
export function modelsFooter(models: ModelsUsed): string {
  const claims = models.claimsModel ? friendlyModelName(models.claimsModel) : "—";
  return `Claims: ${claims} · Verdicts: ${verdictsText(models)} · on Amazon Bedrock`;
}

export interface BuildReportInput {
  prUrl: string;
  headSha: string;
  results: ClaimResult[];
  droppedClaims: number;
  /** Human-readable signal summary lines (signals.ts > buildSignalsSummary). */
  signalsSummary: string[];
  claimsModel: string | null;
  fallbackModel: string | null;
  fallbackCount: number;
  timings: Report["timings"];
  cached?: boolean;
}

/** Aggregates modelsUsed; validates the full report through the zod schema. */
export function buildReport(input: BuildReportInput): Report {
  const verdictsModels: string[] = [];
  for (const result of input.results) {
    if (result.modelUsed !== "none" && !verdictsModels.includes(result.modelUsed)) {
      verdictsModels.push(result.modelUsed);
    }
  }
  const report: Report = {
    grade: computeGrade(input.results),
    trustScore: computeTrustScore(input.results),
    claims: input.results,
    droppedClaims: input.droppedClaims,
    signals: input.signalsSummary,
    modelsUsed: {
      claimsModel: input.claimsModel,
      verdictsModels,
      fallbackCount: input.fallbackCount,
      fallbackModel: input.fallbackModel,
    },
    timings: input.timings,
    headSha: input.headSha,
    prUrl: input.prUrl,
    cached: input.cached ?? false,
  };
  return ReportSchema.parse(report);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const VERDICT_ICON: Record<ClaimResult["verdict"], string> = {
  VERIFIED: "✅",
  CONTRADICTED: "❌",
  UNVERIFIED: "⚠️",
};

function tableCell(text: string, maxLength = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const clamped = cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
  return clamped.replace(/\|/g, "\\|");
}

function evidenceMarkdown(evidence: ClaimResult["evidence"]): string {
  return evidence
    .map((item) => {
      if (item.type === "file" && item.url) {
        const label = item.line !== null ? `${item.path ?? "(file)"}#L${item.line}` : item.path ?? "(file)";
        return `[\`${tableCell(label, 80)}\`](${item.url})`;
      }
      if (item.type === "check_run" && item.url) {
        return `[CI: ${tableCell(item.checkRunName ?? "check", 60)}](${item.url})`;
      }
      if (item.type === "signal") {
        return `\`${item.detail ?? "signal"}\``;
      }
      return "";
    })
    .filter((chip) => chip !== "")
    .join(" · ");
}

/**
 * GitHub-comment-ready markdown. The first line is the hidden
 * `<!-- receipts:report -->` marker so the web app and the P2 comment flow
 * can find/replace a previously posted report.
 */
export function toMarkdown(report: Report): string {
  const verified = report.claims.filter((claim) => claim.verdict === "VERIFIED").length;
  const trust =
    report.trustScore === null
      ? "—"
      : `${Math.round(report.trustScore * 100)}% (${verified}/${report.claims.length} verified)`;

  const lines: string[] = [];
  lines.push("<!-- receipts:report -->");
  lines.push(`## Receipts: ${report.grade} · trust ${trust}`);
  lines.push("");

  if (report.claims.length === 0) {
    lines.push("No checkable claims found in the PR text.");
  } else {
    lines.push("| Verdict | Claim | Reasoning | Evidence |");
    lines.push("|---|---|---|---|");
    for (const result of report.claims) {
      // The self-contained claim text, not the raw quote: quotes can be
      // fragments ("five fail before the fix.") that mean nothing out of context.
      lines.push(
        `| ${VERDICT_ICON[result.verdict]} ${result.verdict} | ` +
          `${tableCell(result.claim.text, 160)} | ${tableCell(result.reasoning)} | ` +
          `${evidenceMarkdown(result.evidence) || "—"} |`,
      );
    }
    lines.push("");
  }

  if (report.droppedClaims > 0) {
    lines.push(
      `⚠️ ${report.droppedClaims} claim(s) dropped by the quote guard ` +
        "(the quoted text was not found in the PR).",
    );
    lines.push("");
  }

  if (report.signals.length > 0) {
    lines.push("**Signals**");
    for (const signal of report.signals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
  }

  const totalSeconds = (report.timings.totalMs / 1000).toFixed(1);
  lines.push(
    `Ran in ${totalSeconds}s · head \`${report.headSha.slice(0, 7)}\` · ` +
      `${report.timings.llmCalls} LLM call(s)${report.cached ? " · from cache" : ""}`,
  );
  lines.push("");
  lines.push(`*${modelsFooter(report.modelsUsed)}*`);
  return lines.join("\n");
}

/** JSON round-trip form, validated through the zod schema. */
export function toJSON(report: Report): string {
  return JSON.stringify(ReportSchema.parse(report), null, 2);
}
