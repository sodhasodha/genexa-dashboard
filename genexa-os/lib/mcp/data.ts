// Data access for the MCP tools. Every read and write is one SQL function
// (supabase/migrations/0028_mcp.sql) that returns a jsonb document, so the
// numbers are the database's own and the tools stay free of Next.js and Supabase.

export const MCP_FUNCTIONS = [
  "mcp_get_overview", "mcp_get_clients", "mcp_get_client", "mcp_get_ad_metrics", "mcp_get_exceptions",
  "mcp_get_tech_jobs", "mcp_get_launches", "mcp_get_scores", "mcp_get_eods", "mcp_get_tasks",
  "mcp_get_prospects", "mcp_get_agency_month", "mcp_get_sync_status", "mcp_task_check",
  "mcp_write_brief", "mcp_add_task", "mcp_add_idea", "mcp_upsert_prospect", "mcp_set_next_action",
  "mcp_log_touch", "mcp_set_exception_action",
] as const;
export type McpFunction = (typeof MCP_FUNCTIONS)[number];

/** A failed database call. `message` is Postgres's own message. */
export class McpDbError extends Error {
  constructor(message: string, readonly sqlState?: string) {
    super(message);
    this.name = "McpDbError";
  }
}

export interface McpData {
  /**
   * Calls one mcp_* SQL function with named arguments and returns its jsonb result.
   * Arguments that are undefined are left out, so the function's default applies.
   * Throws McpDbError when the database refuses.
   */
  call(fn: McpFunction, args?: Record<string, unknown>): Promise<unknown>;
}

/** Drops undefined values: an argument that was not given is not sent. */
export function definedArgs(args: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/** The subset of a Supabase client the endpoint needs. */
type RpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** McpData backed by a Supabase client (the route passes the service-role one). */
export function supabaseData(client: RpcClient): McpData {
  return {
    async call(fn, args) {
      const { data, error } = await client.rpc(fn, definedArgs(args));
      if (error) throw new McpDbError(error.message, error.code);
      return data;
    },
  };
}
