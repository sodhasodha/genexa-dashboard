import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requireEnv, supabaseUrl } from "@/lib/env";

/**
 * Service-role client: bypasses RLS. Only for sync jobs, webhooks, the MCP
 * endpoint and the seed script. Never import this from a page or component.
 */
export function createAdminClient() {
  return createClient(supabaseUrl(), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
