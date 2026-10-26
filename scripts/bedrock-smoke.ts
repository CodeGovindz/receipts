/**
 * Bedrock smoke test: calls FAST, STRONG, and FALLBACK models once each via
 * the Converse API and prints model, latency, token usage, and the parsed
 * reply. Run with `npm run smoke`.
 *
 * Configuration comes from src/core/env.ts (loadDotEnv + getConfig), which
 * also hard-fails when RECEIPTS_MODEL_STRONG is not a cross-region
 * inference profile ID (must start with "us." or "global.") — the bare
 * model ID fails on-demand throughput, which we learned the hard way.
 */
import { getConfig, loadDotEnv } from "../src/core/env";
import { converse, parseModelJson } from "../src/core/llm";

const SYSTEM_PROMPT =
  "You are part of an automated test harness. Respond with valid JSON only — " +
  "no markdown fences, no prose, no explanations.";

const USER_PROMPT = 'Return only this JSON: {"ok":true}';

const CALL_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = getConfig();

  // Kimi K3 (STRONG) rejects inferenceConfig.temperature — omit it there;
  // FAST and FALLBACK get temperature 0 for deterministic replies.
  const models: Array<{
    label: string;
    modelId: string;
    maxTokens: number;
    temperature?: number;
  }> = [
    { label: "FAST", modelId: config.modelFast, maxTokens: 1000, temperature: 0 },
    // Reasoning tokens count against maxTokens, so STRONG gets a generous budget.
    { label: "STRONG", modelId: config.modelStrong, maxTokens: 2000 },
    { label: "FALLBACK", modelId: config.modelFallback, maxTokens: 1000, temperature: 0 },
  ];

  console.log(`Receipts Bedrock smoke test (region: ${config.region})\n`);

  let failures = 0;
  const started = Date.now();

  for (const [index, model] of models.entries()) {
    const prefix = `[${index + 1}/${models.length}] ${model.label.padEnd(8)} ${model.modelId}`;
    try {
      const result = await converse({
        modelId: model.modelId,
        system: SYSTEM_PROMPT,
        user: USER_PROMPT,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      let parsedOk = false;
      try {
        const parsed = parseModelJson(result.text) as { ok?: unknown };
        parsedOk = parsed.ok === true;
      } catch {
        parsedOk = false;
      }
      const status = parsedOk ? "OK" : "REPLIED BUT UNEXPECTED PAYLOAD";
      console.log(
        `${prefix}\n  ${status} · ${result.latencyMs} ms · in ${result.inputTokens} tok · ` +
          `out ${result.outputTokens} tok · parsed: ${JSON.stringify(parsedOk ? { ok: true } : result.text)}`,
      );
      if (!parsedOk) failures++;
    } catch (error) {
      failures++;
      console.log(`${prefix}\n  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const totalSeconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures > 0) {
    console.log(`\n${failures}/${models.length} model call(s) failed (total ${totalSeconds}s).`);
    process.exit(1);
  }
  console.log(`\nAll ${models.length} models replied with the expected JSON (total ${totalSeconds}s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
