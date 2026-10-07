// Silent backfill: read each client channel's recent history, store the
// messages as mode 'backfill' and classify them. Nothing changes on the clinic
// (no touch, no last reply), nothing is sent, and no work is created: requests
// wait as 'pending_approval' until the owner approves them on the router page.
import type { Rpc } from "../jobs/rpc";
import type { Classification, ClassifyInput } from "./classify";
import { toClientMessage } from "./events";
import { ingestClientMessage } from "./ingest";
import { processRequest } from "./process";
import { SlackApiError, type SlackUser } from "./slack";

export type BackfillChannel = { clientName: string; channel: string; kind: "general" | "scheduling" };

export type BackfillDeps = {
  rpc: Rpc;
  channels: BackfillChannel[];
  history: (channel: string, oldest: string) => Promise<unknown[]>;
  lookupUser: (userId: string) => Promise<SlackUser | null>;
  classify: (input: ClassifyInput) => Promise<Classification>;
  days: number;
  now?: Date;
  log?: (line: string) => void;
};

export type BackfillRow = { clinic: string; channel: string; sent: string; status: string; owner: string | null; urgency: string; confidence: number; title: string };

export type BackfillResult = {
  read: number; stored: number; alreadyStored: number; ignored: number; failed: number;
  /** Channels Slack would not let the bot read (e.g. not_in_channel). */
  skippedChannels: { channel: string; clinic: string; error: string }[];
  requests: BackfillRow[];
};

/** Slack errors that mean the install itself is wrong: stop, do not carry on channel by channel. */
const FATAL = new Set(["missing_scope", "invalid_auth", "not_authed", "account_inactive", "token_revoked"]);

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now ?? new Date();
  const oldest = ((now.getTime() - deps.days * 86_400_000) / 1000).toFixed(6);
  const out: BackfillResult = { read: 0, stored: 0, alreadyStored: 0, ignored: 0, failed: 0, skippedChannels: [], requests: [] };
  // users.info failing on scope is as fatal as history failing on it.
  const lookupUser = async (userId: string) => {
    try {
      return await deps.lookupUser(userId);
    } catch (err) {
      if (err instanceof SlackApiError && FATAL.has(err.code)) throw err;
      return null;
    }
  };

  for (const ch of deps.channels) {
    let messages: unknown[];
    try {
      messages = await deps.history(ch.channel, oldest);
    } catch (err) {
      if (err instanceof SlackApiError && !FATAL.has(err.code)) {
        out.skippedChannels.push({ channel: ch.channel, clinic: ch.clientName, error: err.code });
        continue;
      }
      throw err;
    }
    out.read += messages.length;
    // Oldest first, so a repeat of the same ask is recognised in order.
    const sorted = [...messages].sort((a, b) => Number((a as { ts?: string }).ts ?? 0) - Number((b as { ts?: string }).ts ?? 0));
    for (const raw of sorted) {
      const found = toClientMessage(raw, ch.channel);
      if ("ignored" in found) {
        out.ignored++;
        continue;
      }
      const stored = await ingestClientMessage(found.message, { rpc: deps.rpc, lookupUser, now }, "backfill");
      if (stored.action === "ignored") {
        out.ignored++;
        continue;
      }
      if (stored.action === "duplicate") {
        out.alreadyStored++;
        continue;
      }
      out.stored++;
      const r = await processRequest(stored.id, {
        rpc: deps.rpc, classify: deps.classify, now,
        // A backfill never replies and never DMs.
        reply: async () => ({ ok: false, error: "backfill_never_replies" }),
      });
      if (r.outcome === "failed") {
        out.failed++;
        deps.log?.(`  could not classify ${ch.clientName} ${found.message.ts}: ${r.error}`);
      } else if (r.outcome === "routed" && r.classification.is_request) {
        out.requests.push({
          clinic: ch.clientName, channel: ch.kind, sent: new Date(Number(found.message.ts) * 1000).toISOString().slice(0, 16).replace("T", " "),
          status: r.result.status, owner: r.classification.owner, urgency: r.classification.urgency,
          confidence: r.classification.confidence, title: r.classification.title,
        });
      }
    }
  }
  return out;
}
