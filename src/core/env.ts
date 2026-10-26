/**
 * Environment handling for Receipts.
 *
 * Owns the hand-rolled .env loader (no dotenv dependency — see docs/PLAN.md
 * §4) and getConfig(), the typed accessor every entry point (smoke script,
 * CLI, later the web app) uses for region, model IDs, and the GitHub token.
 *
 * This module must stay framework-free: no Next.js imports.
 */
import * as fs from "node:fs";

/** Error thrown when the environment is not usable; message is user-facing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Loads `.env` into process.env without a dependency. Existing environment
 * variables always win, and empty values are skipped so an unset
 * AWS_ACCESS_KEY_ID in .env does not clobber the SDK's default credential
 * chain.
 */
export function loadDotEnv(path = ".env"): void {
  // turbopackIgnore: Next.js loads .env itself; without these hints the
  // bundler traces the whole project into the serverless function.
  if (!fs.existsSync(/*turbopackIgnore: true*/ path)) return;
  const lines = fs.readFileSync(/*turbopackIgnore: true*/ path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (value === "" || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

/** Validated Receipts configuration, sourced from the environment. */
export interface ReceiptsConfig {
  region: string;
  modelFast: string;
  modelStrong: string;
  modelFallback: string;
  /** Read-only GitHub token; undefined when unset (allowed outside production). */
  githubToken: string | undefined;
}

function requiredEnv(name: string, hint: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new ConfigError(`Missing required environment variable ${name}. ${hint}`);
  }
  return raw.trim();
}

/**
 * Reads and validates the environment. Throws ConfigError with a clear,
 * user-facing message when something required is missing or malformed.
 *
 * GITHUB_TOKEN is required when NODE_ENV=production (plan correction 7):
 * without it GitHub's 60 req/h anonymous limit would make the deployed app
 * unusable.
 */
export function getConfig(): ReceiptsConfig {
  const region =
    process.env.RECEIPTS_AWS_REGION?.trim() ||
    requiredEnv("AWS_REGION", "Set RECEIPTS_AWS_REGION or AWS_REGION (e.g. us-east-1) — see .env.example.");
  const modelFast = requiredEnv(
    "RECEIPTS_MODEL_FAST",
    "Set the FAST model ID for claim extraction — see .env.example.",
  );
  const modelStrong = requiredEnv(
    "RECEIPTS_MODEL_STRONG",
    "Set the STRONG model ID for claim verification — see .env.example.",
  );
  const modelFallback = requiredEnv(
    "RECEIPTS_MODEL_FALLBACK",
    "Set the FALLBACK model ID used when STRONG fails — see .env.example.",
  );
  if (!modelStrong.startsWith("us.") && !modelStrong.startsWith("global.")) {
    throw new ConfigError(
      "RECEIPTS_MODEL_STRONG must be a cross-region inference profile ID starting " +
        `with "us." or "global." — the bare model ID fails with on-demand ` +
        `throughput. Got: "${modelStrong}"`,
    );
  }

  const githubToken = process.env.GITHUB_TOKEN?.trim() || undefined;
  if (process.env.NODE_ENV === "production" && !githubToken) {
    throw new ConfigError(
      "GITHUB_TOKEN is required in production. Without it GitHub's anonymous " +
        "rate limit (60 requests/hour) would make Receipts unusable. Add a " +
        "read-only token to the deployment environment.",
    );
  }

  return {
    region,
    modelFast,
    modelStrong,
    modelFallback,
    githubToken,
  };
}
