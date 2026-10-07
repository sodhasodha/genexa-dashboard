// MCP over JSON-RPC 2.0: initialize, ping, tools/list, tools/call.
// Plain functions: no Next.js, no HTTP. lib/mcp/http.ts puts the bearer check and
// the Request/Response in front of this.
import { describeIssues, findTool, toToolError, TOOLS, type ToolContext } from "@/lib/mcp/tools";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
export const SERVER_INFO = { name: "genexa-os", title: "Genexa OS", version: "1.0.0" };
const INSTRUCTIONS =
  "Genexa OS: the agency's computed numbers and working lists. Numbers come from the database as they are shown in the app; null means not known, never zero. Money is USD and days are cut in US Eastern time. Writes are audited as \"claude\" and nothing can be deleted.";

export const RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

type RpcId = string | number | null;
export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };

const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: true };
const toolResult = (value: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError: true as const } : {}),
});

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
  }));
}

class InvalidParams extends Error {}

/** Runs one tool. Bad name or arguments throw InvalidParams; a tool that fails returns isError. */
export async function callTool(params: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!isObject(params) || typeof params.name !== "string") throw new InvalidParams("tools/call needs params.name (the tool to call)");
  const tool = findTool(params.name);
  if (!tool) throw new InvalidParams(`Unknown tool: ${params.name}`);
  const given = params.arguments ?? {};
  if (!isObject(given)) throw new InvalidParams(`Invalid arguments for ${tool.name}: arguments must be an object`);
  const parsed = tool.args.safeParse(given);
  if (!parsed.success) throw new InvalidParams(`Invalid arguments for ${tool.name}: ${describeIssues(parsed.error)}`);
  try {
    return toolResult(await tool.run(parsed.data as never, ctx));
  } catch (err) {
    const e = toToolError(err);
    return toolResult({ error: { code: e.code, message: e.message, ...e.extra } }, true);
  }
}

/** One JSON-RPC message in, one response out. Null for a notification (nothing to send back). */
export async function handleMessage(message: unknown, ctx: ToolContext): Promise<RpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return rpcError(null, RPC.INVALID_REQUEST, "Not a JSON-RPC 2.0 message");
  // A response sent to us (we never ask the client anything): nothing to do.
  if (typeof message.method !== "string") {
    return "result" in message || "error" in message ? null : rpcError(isId(message.id) ? message.id : null, RPC.INVALID_REQUEST, "Missing method");
  }
  if (!("id" in message)) return null; // notification, e.g. notifications/initialized
  if (!isId(message.id)) return rpcError(null, RPC.INVALID_REQUEST, "id must be a string or a number");
  const id = message.id;
  const params = message.params;

  try {
    switch (message.method) {
      case "initialize": {
        const asked = isObject(params) ? params.protocolVersion : undefined;
        const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : DEFAULT_PROTOCOL_VERSION;
        return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: listTools() });
      case "tools/call":
        return ok(id, await callTool(params, ctx));
      default:
        return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (err) {
    if (err instanceof InvalidParams) return rpcError(id, RPC.INVALID_PARAMS, err.message);
    return rpcError(id, RPC.INTERNAL, err instanceof Error ? err.message : "Internal error");
  }
}

/**
 * A parsed request body: one message or a batch.
 * Returns null when there is nothing to send back (only notifications).
 */
export async function handleBody(body: unknown, ctx: ToolContext): Promise<RpcResponse | RpcResponse[] | null> {
  if (!Array.isArray(body)) return handleMessage(body, ctx);
  if (body.length === 0) return rpcError(null, RPC.INVALID_REQUEST, "Empty batch");
  const out: RpcResponse[] = [];
  // In order, one at a time: a batch may write and then read what it wrote.
  for (const message of body) {
    const response = await handleMessage(message, ctx);
    if (response) out.push(response);
  }
  return out.length ? out : null;
}
