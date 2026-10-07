import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupUserIdByEmail, postMessage, slackConfigured } from "@/lib/slack/client";
import { clientWorkspaceToken, replyInClientThread } from "@/lib/slack/workspaces";
import { deliverReminders, supabaseRpc } from "@/lib/reminders/engine";
import { classifyMessage } from "./classify";
import type { IngestDeps } from "./ingest";
import type { ProcessDeps } from "./process";
import { fetchSlackUser } from "./slack";

// The router's real connections: Supabase (service role), the Anthropic API,
// the client workspace (read + thread replies) and the team workspace (owner DMs).

/** False until ANTHROPIC_API_KEY is set: messages are stored and wait, unclassified. */
export const classifierConfigured = () => !!process.env.ANTHROPIC_API_KEY;

export function ingestDeps(db: SupabaseClient = createAdminClient()): IngestDeps {
  return {
    rpc: supabaseRpc(db),
    lookupUser: async (userId) => {
      const token = clientWorkspaceToken();
      if (!token) return null;
      // Short, so Slack still gets its acknowledgement inside 3 seconds.
      return fetchSlackUser(userId, { token, timeoutMs: 1500 });
    },
  };
}

export function processDeps(db: SupabaseClient = createAdminClient()): ProcessDeps {
  const rpc = supabaseRpc(db);
  return {
    rpc,
    classify: (input) => classifyMessage(input, { apiKey: process.env.ANTHROPIC_API_KEY ?? "" }),
    reply: replyInClientThread,
    // Team workspace, team bot: the exception DM for an urgent client request.
    deliverOwnerDms: async () => {
      if (!slackConfigured()) return;
      await deliverReminders({ rpc, send: postMessage, lookupUserIdByEmail, appUrl: appUrl(), rule: "exception_opened", pauseMs: 1100 });
    },
  };
}
