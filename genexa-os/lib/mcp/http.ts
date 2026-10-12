// The HTTP face of the MCP endpoint (streamable HTTP, single JSON responses).
// Web-standard Request/Response only, so it can be tested without Next.js.
import { timingSafeEqual } from "node:crypto";
import type { McpData } from "@/lib/mcp/data";
import { handleBody, RPC, rpcError } from "@/lib/mcp/server";

export type McpHttpDeps = {
  /** The expected bearer token (MCP_BEARER_TOKEN). Unset = every request is refused. */
  token: string | undefined;
  /** Built only after the caller is authorised. */
  data: () => McpData;
  /** Today's date in ET, YYYY-MM-DD. */
  today: () => string;
  /** Read tools only: the write tools are neither listed nor callable. */
  readOnly?: boolean;
  /**
   * The secret taken from the URL path instead of the Authorization header, for
   * clients that cannot send a header (claude.ai custom connectors). Read-only only.
   */
  pathToken?: string;
};

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

/** Constant-time comparison of the Authorization header's bearer token. */
export function authorised(header: string | null, token: string | undefined): boolean {
  if (!token || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export async function handleMcpPost(request: Request, deps: McpHttpDeps): Promise<Response> {
  const header = deps.pathToken !== undefined ? `Bearer ${deps.pathToken}` : request.headers.get("authorization");
  // A secret in the URL is only ever accepted for the read-only connection.
  if ((deps.pathToken !== undefined && !deps.readOnly) || !authorised(header, deps.token)) {
    return json({ error: "unauthorised" }, 401, { "www-authenticate": "Bearer" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(rpcError(null, RPC.PARSE_ERROR, "Parse error: the body is not valid JSON"), 400);
  }
  const response = await handleBody(body, { data: deps.data(), today: deps.today(), readOnly: deps.readOnly === true });
  // Only notifications (or responses): accepted, nothing to say.
  if (response === null) return new Response(null, { status: 202 });
  return json(response);
}

/** GET would open a server-to-client stream; this server has nothing to push. */
export function methodNotAllowed(): Response {
  return json(rpcError(null, RPC.INVALID_REQUEST, "Method not allowed: POST JSON-RPC messages to this endpoint"), 405, { allow: "POST" });
}
