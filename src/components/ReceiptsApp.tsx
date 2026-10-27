"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PipelineEvent } from "@/core/pipeline";
import type { Report } from "@/core/types";
import { ProgressLog } from "./ProgressLog";
import { ReportView } from "./ReportView";

const EXAMPLES = [
  {
    url: "https://github.com/CapSoftware/Cap/pull/3412",
    label: "Cap #3412",
    hint: "“all 41 tests pass”, but CI skipped the tests",
  },
  {
    url: "https://github.com/facebookincubator/dispenso/pull/129",
    label: "dispenso #129",
    hint: "long test plan, no new tests",
  },
  {
    url: "https://github.com/github/docs/pull/46488",
    label: "github/docs #46488",
    hint: "docs-only fix",
  },
];

type Status = "idle" | "running" | "done" | "error";

export function ReceiptsApp() {
  const searchParams = useSearchParams();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const autoRan = useRef(false);

  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [status]);

  const run = useCallback(async (prUrl: string, fresh = false) => {
    const url = prUrl.trim();
    if (url === "") return;
    // Next.js syncs history.replaceState below into useSearchParams; without
    // this the ?pr= auto-run effect would start the same check a second time.
    autoRan.current = true;
    setInput(url);
    setStatus("running");
    setEvents([]);
    setReport(null);
    setTitle(null);
    setError(null);
    setStartedAt(Date.now());
    setNow(Date.now());
    window.history.replaceState(null, "", `?pr=${encodeURIComponent(url)}`);

    const fail = (message: string) => {
      setError(message);
      setStatus("error");
      setNow(Date.now());
    };

    let response: Response;
    try {
      response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: url, fresh }),
      });
    } catch {
      fail("Could not reach the Receipts server.");
      return;
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      fail(body?.error ?? `Request failed (${response.status}).`);
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        const event = JSON.parse(line) as PipelineEvent;
        setEvents((previous) => [...previous, event]);
        if (event.type === "fetched") setTitle(event.title);
        if (event.type === "done") {
          finished = true;
          setReport(event.report);
          setStatus("done");
          setNow(Date.now());
        }
        if (event.type === "error") {
          finished = true;
          fail(event.error);
        }
      }
    }
    if (!finished) fail("The connection closed before the receipt was printed (the server may have timed out).");
  }, []);

  useEffect(() => {
    const pr = searchParams.get("pr");
    if (pr && !autoRan.current) {
      autoRan.current = true;
      void run(pr, searchParams.get("fresh") === "1");
    }
  }, [searchParams, run]);

  const elapsedMs = startedAt === null ? 0 : now - startedAt;

  return (
    <div className="flex w-full flex-col gap-8">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void run(input);
        }}
      >
        <label htmlFor="pr-url" className="sr-only">
          GitHub pull request URL
        </label>
        <input
          id="pr-url"
          type="url"
          required
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-4 py-3 font-mono text-sm text-foreground placeholder:text-muted/60 focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === "running"}
          className="rounded-md bg-accent px-5 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
        >
          {status === "running" ? "Checking…" : "Check the claims"}
        </button>
      </form>

      <div className="mx-auto -mt-4 flex w-full max-w-2xl flex-wrap items-center gap-2 text-xs text-muted">
        <span>Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.url}
            type="button"
            disabled={status === "running"}
            onClick={() => void run(example.url)}
            title={example.hint}
            className="rounded-full border border-line px-3 py-1 font-mono transition hover:border-muted hover:text-foreground disabled:opacity-50"
          >
            {example.label}
          </button>
        ))}
      </div>

      {events.length > 0 || status === "running" ? (
        <ProgressLog events={events} running={status === "running"} elapsedMs={elapsedMs} />
      ) : null}

      {status === "error" && error && events.length === 0 && (
        <p className="mx-auto w-full max-w-2xl rounded-md border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-foreground">
          {error}
        </p>
      )}

      {report && <ReportView report={report} title={title} />}
    </div>
  );
}
