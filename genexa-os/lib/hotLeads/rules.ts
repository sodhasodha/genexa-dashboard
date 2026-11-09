// Hot Leads rules (pure): keyword matching and which leads are hot, and why.
import { NEGATIONS, NEVER_MATCH, WINDOWS } from "./config";

export type HotReason = "reschedule" | "callback" | "mid_conversation";
export const REASON_LABEL: Record<HotReason, string> = {
  reschedule: "Wants to reschedule",
  callback: "Callback requested",
  mid_conversation: "Mid conversation",
};

/** Lower case, apostrophes dropped ("can't" -> "cant"), everything else that is not a letter or digit a space. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Edit distance counting a swap of two neighbouring letters as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Typos allowed for a keyword word: none up to 4 letters, 1 up to 7, 2 beyond. */
const allowed = (word: string) => (word.length <= 4 ? 0 : word.length <= 7 ? 1 : 2);

/** One word of the text against one word of a keyword: exact, a longer form of it, or a small typo. */
function wordMatches(token: string, kw: string): boolean {
  if (token === kw || token.startsWith(kw)) return true;
  const n = allowed(kw);
  if (n === 0 || NEVER_MATCH.some((w) => token.startsWith(w))) return false;
  return editDistance(token, kw) <= n || editDistance(token.slice(0, kw.length), kw) <= n;
}

/** The first keyword found in the text, or null. A keyword right after "don't", "not", "never" or "stop" does not count. */
export function findKeyword(text: string, keywords: string[]): string | null {
  const tokens = normalize(text).split(" ").filter(Boolean);
  for (const keyword of keywords) {
    const kw = normalize(keyword).split(" ").filter(Boolean);
    if (!kw.length) continue;
    for (let i = 0; i + kw.length <= tokens.length; i++) {
      if (!kw.every((w, k) => wordMatches(tokens[i + k], w))) continue;
      const before = ` ${tokens.slice(Math.max(0, i - 3), i).join(" ")} `;
      if (NEGATIONS.some((neg) => before.includes(` ${neg} `))) continue;
      return keyword;
    }
  }
  return null;
}

/** What GHL tells us about one contact, as times in ms (null = never / unknown). */
export type LeadFacts = {
  /** Tagged DNC or not interested. */
  hidden: boolean;
  /** Has an appointment on the confirmation desk (CSRs already call them there). */
  onDesk: boolean;
  /** Has an appointment still to come on any calendar (not cancelled or no-show). */
  upcoming: boolean;
  /** Their latest inbound text, and whether it asks to reschedule or to be called. */
  lastInboundAt: number | null;
  inboundReschedule: boolean;
  inboundCallback: boolean;
  /** Tagged as having asked for a callback, and the conversation's latest message. */
  callbackTag: boolean;
  lastMessageAt: number | null;
};

export type Lead = { reason: HotReason; signal_at: number; last_reply_at: number | null };

/**
 * Whether a contact is a hot lead, and the one reason shown (pure).
 * Anyone with an appointment to come is left out, unless their latest text
 * (last 72h) asks to change it. Anyone on the confirmation desk, DNC or not
 * interested is never shown. Cancellations and no-shows are not leads.
 */
export function decideLead(f: LeadFacts, now: number): Lead | null {
  if (f.hidden || f.onDesk) return null;
  const within = (t: number | null, hours: number): t is number => t !== null && t <= now + 60_000 && now - t <= hours * 3_600_000;
  const reply = within(f.lastInboundAt, WINDOWS.replyHours) ? f.lastInboundAt : null;
  const lead = (reason: HotReason, at: number): Lead => ({ reason, signal_at: at, last_reply_at: reply });
  if (f.inboundReschedule && within(f.lastInboundAt, WINDOWS.keywordHours)) return lead("reschedule", f.lastInboundAt);
  if (f.upcoming) return null;
  if (f.inboundCallback && within(f.lastInboundAt, WINDOWS.keywordHours)) return lead("callback", f.lastInboundAt);
  if (f.callbackTag && within(f.lastMessageAt, WINDOWS.callbackTagDays * 24)) return lead("callback", f.lastMessageAt);
  if (reply !== null) return lead("mid_conversation", reply);
  return null;
}

/** Tags compared without case, with hyphens and underscores as spaces ("wavv-not-interested" contains "not interested"). */
export const hasTag = (tags: string[], wanted: string[], contains = false) => {
  const clean = (x: string) => x.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const t = tags.map(clean);
  return wanted.map(clean).some((w) => t.some((x) => (contains ? x.includes(w) : x === w)));
};

/** Which tier a lead sorts in (pure): 0 wants to reschedule, 1 texted in the last 2h, 2 callback, 3 missed call (not detectable, unused), 4 the rest. */
export function leadTier(l: { reason: HotReason; last_reply_at: string | null }, now: number): number {
  if (l.reason === "reschedule") return 0;
  if (l.last_reply_at && now - Date.parse(l.last_reply_at) <= WINDOWS.freshReplyHours * 3_600_000) return 1;
  if (l.reason === "callback") return 2;
  return 4;
}
