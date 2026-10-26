"use client";

import { useState } from "react";
import { modelsFooter, toMarkdown } from "@/core/report";
import type { ClaimEvidence, ClaimResult, Grade, Report, Verdict } from "@/core/types";

const VERDICT_STYLE: Record<Verdict, { label: string; mark: string; color: string }> = {
  VERIFIED: { label: "Verified", mark: "✓", color: "var(--ok)" },
  CONTRADICTED: { label: "Contradicted", mark: "✕", color: "var(--bad)" },
  UNVERIFIED: { label: "Unverified", mark: "?", color: "var(--warn)" },
};

const GRADE_COLOR: Record<Grade, string> = {
  PASS: "var(--ok)",
  FAIL: "var(--bad)",
  MIXED: "var(--warn)",
};

// Problems first: a reviewer should see contradictions before confirmations.
const VERDICT_ORDER: Record<Verdict, number> = { CONTRADICTED: 0, UNVERIFIED: 1, VERIFIED: 2 };

function prLabel(prUrl: string): string {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : prUrl;
}

function Divider() {
  return <div className="my-5 border-t border-dashed border-paper-line" aria-hidden />;
}

function evidenceLabel(item: ClaimEvidence): string {
  if (item.type === "file" && item.path) {
    const file = item.path.split("/").pop() ?? item.path;
    return item.line !== null ? `${file}:${item.line}` : file;
  }
  if (item.type === "check_run") return `CI: ${item.checkRunName ?? "check"}`;
  return `signal: ${item.detail ?? "?"}`;
}

function EvidenceChip({ item }: { item: ClaimEvidence }) {
  const className =
    "inline-flex max-w-full items-center truncate rounded border border-paper-line px-1.5 py-0.5 font-mono text-[11px] text-ink-muted";
  const title = item.path ?? item.checkRunName ?? item.detail ?? undefined;
  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        title={title}
        className={`${className} hover:border-ink-muted hover:text-ink`}
      >
        {evidenceLabel(item)}
      </a>
    );
  }
  return (
    <span className={className} title={title}>
      {evidenceLabel(item)}
    </span>
  );
}

function ClaimRow({ result }: { result: ClaimResult }) {
  const style = VERDICT_STYLE[result.verdict];
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3 py-3.5">
      <span
        className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full font-mono text-xs font-bold text-white"
        style={{ backgroundColor: style.color }}
        aria-hidden
      >
        {style.mark}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] leading-snug text-ink">
          <span className="sr-only">{style.label}: </span>
          {result.claim.text}
        </p>
        {result.claim.quote !== "" && result.claim.quote !== result.claim.text && (
          <p className="mt-1 text-xs italic leading-snug text-ink-muted">
            “{result.claim.quote}” <span className="not-italic">· {result.claim.source.replace("_", " ")}</span>
          </p>
        )}
        <p className="mt-2 text-[13px] leading-relaxed text-ink/80">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wide" style={{ color: style.color }}>
            {style.label}
          </span>{" "}
          — {result.reasoning}
        </p>
        {result.evidence.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {result.evidence.map((item, index) => (
              <EvidenceChip key={index} item={item} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** `text` is a function so browser-only values (window.location) are read on click, not during render. */
function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="rounded-md border border-ink px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink transition hover:bg-ink hover:text-paper"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ReportView({ report, title }: { report: Report; title: string | null }) {
  const counts = { VERIFIED: 0, CONTRADICTED: 0, UNVERIFIED: 0 };
  for (const result of report.claims) counts[result.verdict]++;
  const sorted = [...report.claims].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict],
  );
  const trust = report.trustScore === null ? "—" : `${Math.round(report.trustScore * 100)}%`;

  return (
    <article className="receipt-print receipt-edge mx-auto w-full max-w-2xl rounded-t-md bg-paper px-5 pt-6 text-ink shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] sm:px-8">
      <header className="text-center font-mono">
        <p className="text-xs uppercase tracking-[0.3em] text-ink-muted">Receipts</p>
        <a
          href={report.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block text-sm font-semibold underline-offset-4 hover:underline"
        >
          {prLabel(report.prUrl)}
        </a>
        {title && <p className="mt-1 font-sans text-sm text-ink-muted">{title}</p>}
      </header>

      <Divider />

      <section className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-muted">Grade</p>
          <p
            className="mt-1 inline-block rounded border-2 px-3 py-0.5 font-mono text-3xl font-bold tracking-wider"
            style={{ color: GRADE_COLOR[report.grade], borderColor: GRADE_COLOR[report.grade] }}
          >
            {report.grade}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-muted">Trust</p>
          <p className="mt-1 font-mono text-3xl font-bold">{trust}</p>
        </div>
      </section>
      <p className="mt-3 font-mono text-xs text-ink-muted">
        {counts.VERIFIED} verified · {counts.CONTRADICTED} contradicted · {counts.UNVERIFIED} unverified
        {report.droppedClaims > 0 && ` · ${report.droppedClaims} dropped (quote not found in PR)`}
      </p>

      <Divider />

      {sorted.length === 0 ? (
        <p className="text-sm text-ink-muted">No checkable claims found in the PR text.</p>
      ) : (
        <ul className="divide-y divide-dashed divide-paper-line">
          {sorted.map((result, index) => (
            <ClaimRow key={index} result={result} />
          ))}
        </ul>
      )}

      {report.signals.length > 0 && (
        <>
          <Divider />
          <section>
            <p className="font-mono text-[11px] uppercase tracking-widest text-ink-muted">Signals (no AI)</p>
            <ul className="mt-2 space-y-1 text-[13px] text-ink/80">
              {report.signals.map((signal) => (
                <li key={signal} className="flex gap-2">
                  <span className="font-mono text-ink-muted">·</span>
                  {signal}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <Divider />

      <footer className="space-y-1 text-center font-mono text-[11px] text-ink-muted">
        <p>{modelsFooter(report.modelsUsed)}</p>
        <p>
          {(report.timings.totalMs / 1000).toFixed(1)}s · head {report.headSha.slice(0, 7)} ·{" "}
          {report.timings.llmCalls} model calls{report.cached ? " · from cache" : ""}
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-4">
          <CopyButton text={() => toMarkdown(report)} label="Copy as PR comment" />
          <CopyButton
            text={() => `${window.location.origin}/?pr=${encodeURIComponent(report.prUrl)}`}
            label="Copy share link"
          />
        </div>
      </footer>
    </article>
  );
}
