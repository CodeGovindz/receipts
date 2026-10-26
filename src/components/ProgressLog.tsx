"use client";

import { friendlyModelName } from "@/core/report";
import type { PipelineEvent } from "@/core/pipeline";

function describe(event: PipelineEvent): string | null {
  switch (event.type) {
    case "fetching":
      return "Fetching the PR, diff and CI checks from GitHub";
    case "fetched":
      return `Fetched “${event.title}” · ${event.filesChanged} files · ${event.checkRuns} CI checks`;
    case "extracting":
      return "Extracting claims from the PR text";
    case "extracted":
      if (event.error) return `Claim extraction failed: ${event.error}`;
      return (
        `Found ${event.total} checkable claim${event.total === 1 ? "" : "s"}` +
        (event.dropped > 0 ? ` (${event.dropped} dropped: quote not found in PR)` : "")
      );
    case "verifying":
      return `Checking ${event.index}/${event.total} · ${event.claim}`;
    case "fallback":
      return `${friendlyModelName(event.from)} → ${friendlyModelName(event.to)} for claim ${event.index} (${event.reason})`;
    case "done":
      return "Receipt printed";
    case "error":
      return event.error;
  }
}

export function ProgressLog({
  events,
  running,
  elapsedMs,
}: {
  events: PipelineEvent[];
  running: boolean;
  elapsedMs: number;
}) {
  const lines = events
    .map((event) => ({ event, text: describe(event) }))
    .filter((line): line is { event: PipelineEvent; text: string } => line.text !== null);

  return (
    <div className="mx-auto w-full max-w-2xl rounded-lg border border-line bg-panel p-4 font-mono text-[12.5px] leading-relaxed">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-widest text-muted">
        <span>{running ? "Running" : "Log"}</span>
        <span aria-live="off">{(elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      <ol className="space-y-1" aria-live="polite">
        {lines.map(({ event, text }, index) => {
          const isLast = index === lines.length - 1;
          const isError = event.type === "error";
          const marker = isError ? "!" : isLast && running ? "›" : "✓";
          return (
            <li key={index} className="flex gap-2">
              <span
                className={
                  isError ? "text-bad" : isLast && running ? "animate-pulse text-accent" : "text-ok"
                }
                aria-hidden
              >
                {marker}
              </span>
              <span className={`min-w-0 truncate ${isError ? "text-bad" : "text-foreground/85"}`} title={text}>
                {text}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
