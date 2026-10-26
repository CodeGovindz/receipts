import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BedrockRuntimeClient,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import {
  callJson,
  callStrong,
  converse,
  ModelCallError,
  parseModelJson,
  setBedrockClientForTesting,
  stripCodeFences,
  textBlocksOnly,
  type CallJsonOptions,
  type CallStrongOptions,
} from "../llm";

/** Shape of the command object the SDK passes to send() — narrowed for assertions. */
interface CommandStub {
  input?: {
    modelId?: string;
    messages?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
}

interface SendOptions {
  abortSignal?: AbortSignal;
}

type SendFn = (command: unknown, options?: SendOptions) => Promise<ConverseCommandOutput>;

/** Installs a stub Bedrock client whose send() is the given function. */
function stubClient(send: SendFn): BedrockRuntimeClient {
  return { send } as unknown as BedrockRuntimeClient;
}

/** A send() that rejects when its abort signal fires (simulates a hung request). */
function hangUntilAborted(): SendFn {
  return (_command: unknown, options?: SendOptions) =>
    new Promise<ConverseCommandOutput>((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });
}

function throttleError(): Error & { name: string; $metadata?: { httpStatusCode?: number } } {
  const error = new Error("Rate exceeded") as Error & {
    name: string;
    $metadata?: { httpStatusCode?: number };
  };
  error.name = "ThrottlingException";
  error.$metadata = { httpStatusCode: 429 };
  return error;
}

afterEach(() => {
  setBedrockClientForTesting(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 4-step parse pipeline (no network)
// ---------------------------------------------------------------------------

function outputWith(blocks: unknown[]): ConverseCommandOutput {
  return { output: { message: { content: blocks } } } as unknown as ConverseCommandOutput;
}

function okOutput(text: string, inputTokens = 10, outputTokens = 5): ConverseCommandOutput {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens, outputTokens },
  } as unknown as ConverseCommandOutput;
}

describe("step 1: textBlocksOnly ignores reasoningContent blocks", () => {
  it("keeps only text blocks and drops reasoning blocks", () => {
    const output = outputWith([
      { reasoningContent: { text: "I should reason about the JSON…" } },
      { text: '{"claims":[]}' },
      { reasoningContent: { text: "more private reasoning" } },
    ]);
    expect(textBlocksOnly(output)).toBe('{"claims":[]}');
  });

  it("joins multiple text blocks", () => {
    const output = outputWith([{ text: '{"a":' }, { text: "1}" }]);
    expect(textBlocksOnly(output)).toBe('{"a":\n1}');
  });
});

describe("step 2: stripCodeFences", () => {
  it("strips ```json fences", () => {
    expect(stripCodeFences('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it("strips bare fences and returns plain JSON unchanged", () => {
    expect(stripCodeFences('```\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripCodeFences('{"ok":true}')).toBe('{"ok":true}');
  });
});

describe("steps 3/4: parseModelJson handles fenced, prose-wrapped, and unparseable text", () => {
  it("parses pure JSON", () => {
    expect(parseModelJson('{"claims":[]}')).toEqual({ claims: [] });
  });

  it("parses fenced JSON", () => {
    expect(parseModelJson('```json\n{"claims":[{"text":"x"}]}\n```')).toEqual({
      claims: [{ text: "x" }],
    });
  });

  it("parses prose-wrapped JSON by extracting the first balanced block", () => {
    const prose =
      'Sure! Here is the JSON you asked for: {"verdict":"VERIFIED","confidence":0.9} — hope that helps!';
    expect(parseModelJson(prose)).toEqual({ verdict: "VERIFIED", confidence: 0.9 });
  });

  it("extracts the right block when prose contains braces inside strings", () => {
    const prose = 'Answer: {"note":"contains } brace","list":[1,2]} done';
    expect(parseModelJson(prose)).toEqual({ note: "contains } brace", list: [1, 2] });
  });

  it("parses a top-level array wrapped in prose", () => {
    expect(parseModelJson("results: [1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws when there is no JSON at all", () => {
    expect(() => parseModelJson("I could not produce valid output.")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// converse: AbortController timeout -> typed TimeoutError
// ---------------------------------------------------------------------------

describe("converse timeout uses real cancellation", () => {
  it("aborts the HTTP request and throws TimeoutError", async () => {
    const send = vi.fn(hangUntilAborted());
    setBedrockClientForTesting(stubClient(send));

    await expect(
      converse({ modelId: "test-model", system: "s", user: "u", timeoutMs: 30 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(send).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// callJson: zod validation + one same-model retry with the error fed back
// ---------------------------------------------------------------------------

const replySchema = z.object({ ok: z.boolean() });

function baseCallOptions(overrides: Partial<CallJsonOptions> = {}): CallJsonOptions {
  return { modelId: "test-model", system: "s", user: "answer with JSON", ...overrides };
}

describe("callJson", () => {
  it("returns schema-valid data on the first attempt", async () => {
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) => okOutput('{"ok":true}'));
    setBedrockClientForTesting(stubClient(send));
    const result = await callJson(baseCallOptions(), replySchema);
    expect(result.data).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(result.modelUsed).toBe("test-model");
    expect(result.tokens).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("retries once on the SAME model, feeding the zod error back", async () => {
    let calls = 0;
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) => {
      calls++;
      return calls === 1 ? okOutput('{"ok":"not-a-boolean"}') : okOutput('{"ok":true}');
    });
    setBedrockClientForTesting(stubClient(send));

    const result = await callJson(baseCallOptions(), replySchema);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ ok: true });
    expect(result.attempts).toBe(2);

    const firstCommand = send.mock.calls[0]?.[0] as CommandStub;
    const retryCommand = send.mock.calls[1]?.[0] as CommandStub;
    const firstText = String(firstCommand.input?.messages?.[0]?.content?.[0]?.text ?? "");
    const retryText = String(retryCommand.input?.messages?.[0]?.content?.[0]?.text ?? "");
    expect(firstText).toBe("answer with JSON");
    expect(retryText).toContain("answer with JSON");
    expect(retryText).toContain("failed validation");
    
  });

  it("throws ModelCallError when the retry also fails validation", async () => {
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) =>
      okOutput("still not json"),
    );
    setBedrockClientForTesting(stubClient(send));
    await expect(callJson(baseCallOptions(), replySchema)).rejects.toBeInstanceOf(ModelCallError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a timeout (a timeout is not a parse failure)", async () => {
    const send = vi.fn(hangUntilAborted());
    setBedrockClientForTesting(stubClient(send));
    await expect(
      callJson(baseCallOptions({ timeoutMs: 25 }), replySchema),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(send).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// callStrong: STRONG -> FALLBACK failover policy (plan correction 1)
// ---------------------------------------------------------------------------

function strongOptions(overrides: Partial<CallStrongOptions> = {}): CallStrongOptions {
  return {
    strongModelId: "strong-model",
    fallbackModelId: "fallback-model",
    system: "s",
    user: "judge one claim",
    ...overrides,
  };
}

describe("callStrong", () => {
  it("uses STRONG when it succeeds", async () => {
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) => okOutput('{"ok":true}'));
    setBedrockClientForTesting(stubClient(send));
    const result = await callStrong(strongOptions(), replySchema);
    expect(result.modelUsed).toBe("strong-model");
    expect(result.fallbackUsed).toBe(false);
    const command = send.mock.calls[0]?.[0] as CommandStub;
    expect(command.input?.modelId).toBe("strong-model");
  });

  it("fails over to FALLBACK on a STRONG timeout, reporting the final model", async () => {
    const send = vi.fn(async (command: unknown, options?: SendOptions) => {
      const { modelId } = (command as CommandStub).input ?? {};
      if (modelId === "strong-model") {
        return await new Promise<ConverseCommandOutput>((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return okOutput('{"ok":true}');
    });
    setBedrockClientForTesting(stubClient(send));

    const onFallback = vi.fn();
    const result = await callStrong(
      strongOptions({ strongTimeoutMs: 25, onFallback }),
      replySchema,
    );
    expect(result.modelUsed).toBe("fallback-model");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toContain("timed out");
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ from: "strong-model", to: "fallback-model" }),
    );
  });

  it("fails over to FALLBACK when STRONG throws throttling after SDK retries", async () => {
    let calls = 0;
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) => {
      calls++;
      if (calls === 1) throw throttleError();
      return okOutput('{"ok":true}');
    });
    setBedrockClientForTesting(stubClient(send));

    const result = await callStrong(strongOptions(), replySchema);
    expect(result.fallbackUsed).toBe(true);
    expect(result.modelUsed).toBe("fallback-model");
    expect(result.fallbackReason).toContain("Throttling");
  });

  it("does NOT fail over on a parse failure (parse failures never switch models)", async () => {
    const send = vi.fn(async (_command: unknown, _options?: SendOptions) =>
      okOutput("gibberish that is not json"),
    );
    setBedrockClientForTesting(stubClient(send));

    const onFallback = vi.fn();
    await expect(callStrong(strongOptions({ onFallback }), replySchema)).rejects.toBeInstanceOf(
      ModelCallError,
    );
    expect(send).toHaveBeenCalledTimes(2); // both on the STRONG model
    expect(onFallback).not.toHaveBeenCalled();
    const secondCommand = send.mock.calls[1]?.[0] as CommandStub;
    expect(secondCommand.input?.modelId).toBe("strong-model");
  });

  it("propagates a FALLBACK timeout (the claim upstream becomes UNVERIFIED)", async () => {
    // STRONG throttles immediately (already retried at SDK level) — but then
    // the FALLBACK hangs until its own abort fires: no model can answer.
    const send = vi.fn((command: unknown, options?: SendOptions) => {
      const { modelId } = (command as CommandStub).input ?? {};
      if (modelId === "strong-model") {
        return Promise.reject(throttleError());
      }
      return new Promise<ConverseCommandOutput>((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    setBedrockClientForTesting(stubClient(send));

    await expect(
      callStrong(strongOptions({ fallbackTimeoutMs: 30 }), replySchema),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
