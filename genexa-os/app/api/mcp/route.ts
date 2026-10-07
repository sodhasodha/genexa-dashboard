import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseData } from "@/lib/mcp/data";
import { handleMcpPost, methodNotAllowed } from "@/lib/mcp/http";
import { etToday } from "@/lib/time";

// MCP over streamable HTTP. "Authorization: Bearer MCP_BEARER_TOKEN". See MCP.md.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleMcpPost(request, {
    token: process.env.MCP_BEARER_TOKEN,
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
