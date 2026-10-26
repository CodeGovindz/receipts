/**
 * Remote MCP server (Streamable HTTP, stateless): a fresh server and
 * transport per request, so it works on serverless functions. JSON responses
 * instead of SSE, since every tool call finishes in one response.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { clientKey } from "@/lib/ratelimit";
import { createReceiptsMcpServer } from "@/mcp/server";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const server = createReceiptsMcpServer(clientKey(request.headers));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless, use POST." }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
