// The owner's DM for one outcome a clinic reported in Slack. Pure, so tests can check it.

export type Candidate = { contact_id: string; name: string; stage: string; appointment: string | null };
export type ProposalView = {
  id: string;
  clinic: string;
  message: string;
  permalink: string;
  patient: string;
  outcome: "no_show" | "closed_won" | "not_closed";
  amount: number | null;
  candidates: Candidate[];
  timezone: string;
};

export const OUTCOME_WORD: Record<ProposalView["outcome"], string> = { no_show: "No Show", closed_won: "Closed", not_closed: "Not closed" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const when = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "no appointment";

export const outcomeText = (v: Pick<ProposalView, "outcome" | "amount">) =>
  v.outcome === "closed_won" ? `Closed${v.amount ? ` for ${usd(v.amount)}` : ", amount not given (clinic will be asked for it)"}` : OUTCOME_WORD[v.outcome];

/** One Confirm button per patient the name could mean (up to 3), and Ignore. */
export function proposalBlocks(v: ProposalView): { text: string; blocks: unknown[] } {
  const text = `${v.clinic}: log ${v.patient} as ${outcomeText(v)}?`;
  const quote = esc(v.message.length > 400 ? `${v.message.slice(0, 400)}…` : v.message).replace(/\n/g, "\n>");
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${esc(v.clinic)}* said in Slack (<${v.permalink}|open>):\n>${quote}` } },
    { type: "section", text: { type: "mrkdwn", text: `Log *${esc(v.patient)}* as *${esc(outcomeText(v))}* on their dashboard?` } },
  ];
  if (!v.candidates.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No patient with that name is on their dashboard, so there is nothing to log. Ask the clinic or add the patient." }] });
    return { text, blocks };
  }
  blocks.push({
    type: "actions",
    block_id: `act:outcome_proposals:${v.id}`,
    elements: [
      ...v.candidates.slice(0, 3).map((c, i) => ({
        type: "button",
        action_id: `outcome_confirm_${i}`,
        style: "primary",
        text: { type: "plain_text", text: `Confirm: ${c.name}`.slice(0, 75) },
        value: `${v.id}:${c.contact_id}`,
      })),
      { type: "button", action_id: "outcome_ignore", text: { type: "plain_text", text: "Ignore" }, value: `${v.id}:` },
    ],
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: v.candidates.slice(0, 3).map((c) => `${esc(c.name)}: ${esc(c.stage)}, ${when(c.appointment, v.timezone)}`).join(" · ") }],
  });
  return { text, blocks };
}
