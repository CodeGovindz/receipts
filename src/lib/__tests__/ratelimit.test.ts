import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRateLimit,
  clientKey,
  RATE_LIMIT_RUNS,
  RATE_LIMIT_WINDOW_MS,
  takeRun,
} from "../ratelimit";

describe("takeRun", () => {
  beforeEach(() => clearRateLimit());

  it("allows RATE_LIMIT_RUNS runs per window, then refuses with a retry time", () => {
    const start = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_RUNS; i++) {
      expect(takeRun("1.2.3.4", start + i).ok).toBe(true);
    }
    // The oldest run (at `start`) leaves the window 3600 s after it happened.
    const refused = takeRun("1.2.3.4", start + RATE_LIMIT_RUNS);
    expect(refused).toEqual({ ok: false, retryAfterSec: 3600 });
  });

  it("frees a slot once the oldest run leaves the window", () => {
    const start = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_RUNS; i++) takeRun("ip", start);
    expect(takeRun("ip", start + RATE_LIMIT_WINDOW_MS - 1).ok).toBe(false);
    expect(takeRun("ip", start + RATE_LIMIT_WINDOW_MS).ok).toBe(true);
  });

  it("counts each client separately", () => {
    for (let i = 0; i < RATE_LIMIT_RUNS; i++) takeRun("a", 0);
    expect(takeRun("a", 1).ok).toBe(false);
    expect(takeRun("b", 1).ok).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first x-forwarded-for address", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientKey(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
