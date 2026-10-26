import { Suspense } from "react";
import { ReceiptsApp } from "@/components/ReceiptsApp";

const REPO_URL = "https://github.com/CodeGovindz/receipts";

const STEPS = [
  {
    title: "Extract",
    body: "An open model reads the PR title, description and commits and pulls out every checkable claim: “added tests”, “all tests pass”, “no breaking changes”.",
  },
  {
    title: "Check",
    body: "Kimi K3 checks each claim against the real diff, the changed test files and every CI check, which are first classified as test, lint, build or deploy without AI.",
  },
  {
    title: "Guard",
    body: "Every verdict must cite a file, line or CI check that really exists in the PR. A verdict with made-up evidence becomes unverified, so a PR description can't talk its way to a pass.",
  },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col px-4 pb-20 pt-14 sm:px-6 sm:pt-20">
      <section className="mx-auto w-full max-w-2xl text-center">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-accent">Receipts</p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Every agent claim, with a receipt.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-muted">
          Coding agents write confident pull requests. Paste one here and Receipts checks every claim
          in it against the actual diff and CI: <span className="text-ok">verified</span>,{" "}
          <span className="text-bad">contradicted</span> or <span className="text-warn">unverified</span>, each
          with proof.
        </p>
      </section>

      <section className="mt-10">
        <Suspense fallback={null}>
          <ReceiptsApp />
        </Suspense>
      </section>

      <section className="mx-auto mt-20 grid w-full max-w-4xl gap-4 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <div key={step.title} className="rounded-lg border border-line bg-panel p-5">
            <p className="font-mono text-xs text-muted">0{index + 1}</p>
            <h2 className="mt-1 font-semibold">{step.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
          </div>
        ))}
      </section>

      <footer className="mx-auto mt-16 w-full max-w-4xl border-t border-line pt-6 text-center text-xs leading-relaxed text-muted">
        <p>
          Open source (MIT) ·{" "}
          <a href={REPO_URL} className="underline underline-offset-4 hover:text-foreground">
            github.com/CodeGovindz/receipts
          </a>{" "}
          · Runs only on open-weight models on Amazon Bedrock · Also available as an Alan plugin
        </p>
      </footer>
    </main>
  );
}
