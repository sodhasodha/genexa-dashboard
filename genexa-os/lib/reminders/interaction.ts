// The Done / Snooze 1h buttons, and the two prospect controls ("Not following up",
// "Follow up later"). SQL (slack_action, slack_prospect_action) decides whether the
// person may act and makes the change; this reads Slack's payload and words the reply.
import { isReason, REASON_LABEL } from "@/lib/pipeline/reasons";
import type { Block } from "./compose";
import { day, esc } from "./compose";
import type { Rpc } from "./engine";

/** What goes back to Slack's response_url. */
export type InteractionReply = {
  replace_original: boolean;
  response_type?: "ephemeral";
  text: string;
  blocks?: Block[];
};

type SlackAction = {
  action_id?: string;
  value?: string;
  /** The block the control sits in: `act:prospects:<id>` for the prospect controls. */
  block_id?: string;
  /** A menu's choice. */
  selected_option?: { value?: string } | null;
  /** A date picker's choice, YYYY-MM-DD. */
  selected_date?: string | null;
};

type SlackPayload = {
  type?: string;
  user?: { id?: string };
  actions?: SlackAction[];
  message?: { text?: string; blocks?: Block[] };
  response_url?: string;
};

type ActionResult = { result: string; actor?: string; title?: string };
type ProspectResult = { result: string; actor?: string; name?: string; stage?: string; reason?: string; date?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NOT_UNDERSTOOD = "That button is not something Genexa OS understands.";
const refuse = (text: string): InteractionReply => ({ replace_original: false, response_type: "ephemeral", text });

/** The action ids of the two prospect controls. */
export const PROSPECT_ACTIONS = ["prospect_not_following_up", "prospect_follow_up_later"];

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

/** The same message, with one item's buttons swapped for what happened. */
function replaceBlock(payload: SlackPayload, blockId: string, outcome: string, title?: string): InteractionReply {
  const original = payload.message?.blocks ?? [];
  const blocks = original.map((b) => (b.block_id === blockId ? { type: "context", elements: [{ type: "mrkdwn", text: esc(outcome) }] } : b));
  const text = `${outcome}${title ? `: ${title}` : ""}`;
  return original.length ? { replace_original: true, text, blocks } : { replace_original: true, text };
}

/** "Not following up" (a reason menu) and "Follow up later" (a date picker) on a prospect reminder. */
async function handleProspect(payload: SlackPayload, action: SlackAction, slackUser: string, rpc: Rpc): Promise<InteractionReply> {
  const [prefix, recordType, prospectId] = (action.block_id ?? "").split(":");
  if (prefix !== "act" || recordType !== "prospects" || !UUID.test(prospectId ?? "")) return refuse(NOT_UNDERSTOOD);

  const closing = action.action_id === "prospect_not_following_up";
  const reason = action.selected_option?.value;
  const date = action.selected_date ?? "";
  if (closing ? !isReason(reason) : !DAY.test(date)) return refuse(NOT_UNDERSTOOD);

  // "Other" has no text box in Slack: the database stores it as other / "Chosen in Slack".
  const r = await rpc<ProspectResult>("slack_prospect_action", {
    p_slack_user: slackUser,
    p_action: closing ? "not_following_up" : "follow_up_later",
    p_prospect: prospectId,
    p_reason: closing ? reason : null,
    p_date: closing ? null : date,
  });

  const blockId = `act:prospects:${prospectId}`;
  switch (r?.result) {
    case "unknown_user":
      return refuse("Your Slack account is not linked to a Genexa OS login, so nothing was changed.");
    case "refused":
      return refuse("Only the owner can close a prospect follow-up. Nothing was changed.");
    case "not_found":
      return refuse("That prospect no longer exists. Nothing was changed.");
    case "date_not_future":
      return refuse("Pick a date after today. Nothing was changed.");
    case "not_open":
      return replaceBlock(payload, blockId, `This prospect is already ${r.stage === "paid" ? "paid" : "closed"}. Nothing was changed.`, r.name);
    case "not_following_up":
      return replaceBlock(payload, blockId, `🚫 Not following up (${REASON_LABEL[r.reason ?? ""] ?? "no reason"}) · moved to Dead by ${r.actor}. Undo on the prospect's page.`, r.name);
    case "follow_up_later":
      return replaceBlock(payload, blockId, `📅 Follow up moved to ${day(r.date)} by ${r.actor}. Reminders pause until then.`, r.name);
    default:
      return refuse("Nothing was changed.");
  }
}

export async function handleInteraction(payload: SlackPayload, deps: { rpc: Rpc; now?: Date }): Promise<InteractionReply> {
  const action = payload.actions?.[0];
  const slackUser = payload.user?.id;
  if (payload.type !== "block_actions" || !action || !slackUser) return refuse(NOT_UNDERSTOOD);
  if (PROSPECT_ACTIONS.includes(action.action_id ?? "")) return handleProspect(payload, action, slackUser, deps.rpc);

  const verb = action.action_id === "done" ? "done" : action.action_id === "snooze_1h" ? "snooze" : null;
  const [recordType, recordId] = (action.value ?? "").split(":");
  if (!verb || !["tasks", "exceptions"].includes(recordType) || !UUID.test(recordId ?? "")) {
    return refuse(NOT_UNDERSTOOD);
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

  return replaceBlock(payload, `act:${recordType}:${recordId}`, outcome, r.title);
}
