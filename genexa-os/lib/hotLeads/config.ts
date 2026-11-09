// Hot Leads: every word list and time window in one place. Edit here, then deploy.
// Matching ignores case, apostrophes and punctuation, and allows small typos and
// word endings ("cancle", "cancellation", "rescheduling", "cnt make it").
// Words of 4 letters or fewer must be spelled right ("sick", "cant", "late").

/** In the patient's latest text (last 72h): they want to change an appointment. Badge "Wants to reschedule". */
export const RESCHEDULE_KEYWORDS = [
  "cancel", "cancelled", "reschedule", "resched", "move my appointment", "change my appointment",
  "different day", "different time", "can't make it", "cant make it", "won't make it", "not going to make it",
  "something came up", "push back", "postpone", "another time", "running late", "sick", "emergency",
];

/** In the patient's latest text (last 72h): they asked to be called. Badge "Callback requested". */
export const CALLBACK_KEYWORDS = ["call me", "callback", "call back", "give me a call", "can you call", "ring me"];

/** GHL tags the dialers put on a contact who asked for a callback. Badge "Callback requested". */
export const CALLBACK_TAGS = ["requested callback", "wavv-callback"];

/** A contact with a tag containing any of these is never shown. */
export const HIDE_TAGS = ["dnc", "do not call", "do not contact", "not interested"];

/** Words that look like a keyword but are not one (stops "cancer" matching "cancel"). */
export const NEVER_MATCH = ["cancer", "cancers"];

/** A keyword right after one of these is ignored ("I don't want to cancel", "don't call me"). Checked over the 3 words before it. */
export const NEGATIONS = ["dont", "do not", "not", "never", "stop"];

export const WINDOWS = {
  /** A keyword counts only if the latest text came in within this many hours. */
  keywordHours: 72,
  /** "Mid conversation": texted us within this many hours. */
  replyHours: 48,
  /** Sorted to the top after "Wants to reschedule": texted within this many hours. */
  freshReplyHours: 2,
  /** A callback tag counts while the conversation has had a message within this many days (GHL does not date tags). */
  callbackTagDays: 7,
  /** "Cancelled": an appointment cancelled (or logged Rescheduled on the desk) within this many days. */
  cancelledDays: 14,
  /** "No-show": a no-show appointment within this many days. */
  noShowDays: 7,
  /** Greyed out for everyone this long after a CSR opens the lead. */
  claimMinutes: 15,
};
