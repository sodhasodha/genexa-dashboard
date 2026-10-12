import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseData } from "@/lib/mcp/data";
import { handleMcpPost, methodNotAllowed } from "@/lib/mcp/http";
import { etToday } from "@/lib/time";

// Read-only MCP for clients that cannot send an Authorization header (claude.ai
// custom connectors): the secret (MCP_READONLY_TOKEN) is the last part of the URL.
// Only the read tools exist here. See MCP.md.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, ctx: RouteContext<"/api/mcp/ro/[token]">) {
  const { token } = await ctx.params;
  return handleMcpPost(request, {
    token: process.env.MCP_READONLY_TOKEN,
    pathToken: token,
    readOnly: true,
    data: () => supabaseData(createAdminClient()),
    today: () => etToday(),
  });
}

export function GET() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}
