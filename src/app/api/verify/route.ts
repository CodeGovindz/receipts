/**
 * POST /api/verify { prUrl, fresh? } -> NDJSON stream of pipeline events
 * (one JSON object per line). The final line is either a `done` event
 * carrying the full Report or an `error` event.
 */
import { z } from "zod";
import { parsePrUrl } from "@/core/github";
import { runReceipts, type PipelineEvent } from "@/core/pipeline";
import { clientKey, takeRun } from "@/lib/ratelimit";

// Long PRs with Kimi K3 reasoning can take ~45 s; Fluid compute allows 300 s.
export const maxDuration = 300;

const RequestSchema = z.object({
  prUrl: z.string().trim().min(1).max(500),
  fresh: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Send JSON like {\"prUrl\": \"https://github.com/o/r/pull/1\"}." }, { status: 400 });
  }
  try {
    parsePrUrl(body.prUrl);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Not a GitHub PR URL." }, { status: 400 });
  }

  const limit = takeRun(clientKey(request.headers));
  if (!limit.ok) {
    const minutes = Math.ceil(limit.retryAfterSec / 60);
    return Response.json(
      { error: `Rate limit reached (10 runs per hour). Try again in ${minutes} min, or self-host Receipts.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false;
      const send = (event: PipelineEvent): void => {
        if (event.type === "done" || event.type === "error") finished = true;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await runReceipts(body.prUrl, { onEvent: send, fresh: body.fresh });
      } catch (error) {
        // runReceipts emits its own error event, except for config errors
        // thrown before the pipeline starts.
        if (!finished) {
          send({ type: "error", error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
