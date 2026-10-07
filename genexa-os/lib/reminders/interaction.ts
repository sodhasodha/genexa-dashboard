// The Done / Snooze 1h buttons. slack_action (SQL) decides whether the person may
// act and makes the change; this reads Slack's payload and words the reply.
import type { Block } from "./compose";
import { esc } from "./compose";
import type { Rpc } from "./engine";

/** What goes back to Slack's response_url. */
export type InteractionReply = {
  replace_original: boolean;
  response_type?: "ephemeral";
  text: string;
  blocks?: Block[];
};

type SlackPayload = {
  type?: string;
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
  message?: { text?: string; blocks?: Block[] };
  response_url?: string;
};

type ActionResult = { result: string; actor?: string; title?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (text: string): InteractionReply => ({ replace_original: false, response_type: "ephemeral", text });

/** Reads the `payload` field of Slack's form-encoded interactivity request. */
export function parseInteractionBody(rawBody: string): SlackPayload | null {
  const field = new URLSearchParams(rawBody).get("payload");
  if (!field) return null;
  try {
    const parsed: unknown = JSON.parse(field);
    return parsed && typeof parsed === "object" ? (parsed as SlackPayload) : null;
  } catch {
    return null;
  }
}

export async function handleInteraction(payload: SlackPayload, deps: { rpc: Rpc; now?: Date }): Promise<InteractionReply> {
  const action = payload.actions?.[0];
  const slackUser = payload.user?.id;
  if (payload.type !== "block_actions" || !action || !slackUser) return refuse("That button is not something Genexa OS understands.");

  const verb = action.action_id === "done" ? "done" : action.action_id === "snooze_1h" ? "snooze" : null;
  const [recordType, recordId] = (action.value ?? "").split(":");
  if (!verb || !["tasks", "exceptions"].includes(recordType) || !UUID.test(recordId ?? "")) {
    return refuse("That button is not something Genexa OS understands.");
  }

  const r = await deps.rpc<ActionResult>("slack_action", {
    p_slack_user: slackUser,
    p_action: verb,
    p_record_type: recordType,
    p_record_id: recordId,
    p_now: (deps.now ?? new Date()).toISOString(),
  });

  const noun = recordType === "tasks" ? "task" : "exception";
  switch (r?.result) {
    case "unknown_user":
      return refuse("Your Slack account is not linked to a Genexa OS login, so nothing was changed.");
    case "refused":
      return refuse(`Only the owner of this ${noun} can do that. Nothing was changed.`);
    case "not_found":
      return refuse(`That ${noun} no longer exists. Nothing was changed.`);
    case "done":
    case "snoozed":
    case "already_done":
      break;
    default:
      return refuse("Nothing was changed.");
  }

  const outcome =
    r.result === "done"
      ? `✅ Done by ${r.actor}`
      : r.result === "already_done"
        ? "✅ Already done"
        : recordType === "tasks"
          ? `💤 Snoozed 1h by ${r.actor}. A new reminder comes in an hour.`
          : `💤 Snoozed 1h by ${r.actor}`;

  // Same message, with this item's buttons swapped for what happened.
  const blockId = `act:${recordType}:${recordId}`;
  const original = payload.message?.blocks ?? [];
  const blocks = original.map((b) => (b.block_id === blockId ? { type: "context", elements: [{ type: "mrkdwn", text: esc(outcome) }] } : b));
  const text = `${outcome}${r.title ? `: ${r.title}` : ""}`;
  return original.length ? { replace_original: true, text, blocks } : { replace_original: true, text };
}
