// Why a prospect is not being followed up. The keys are what the database stores
// (prospect_follow_up_decisions.reason); the labels are what people read.
export const NOT_FOLLOWING_UP_REASONS = [
  { key: "not_a_fit", label: "Not a fit" },
  { key: "went_elsewhere", label: "Went with someone else" },
  { key: "gone_cold", label: "Gone cold" },
  { key: "other", label: "Other" },
] as const;

/** What the Pipeline pages say after one of the decision forms (the `error` / `saved` query values). */
export const DECISION_ERRORS: Record<string, string> = {
  owner_only: "Not saved: only the owner can close or move a follow-up.",
  not_open: "Not saved: that prospect is already paid or dead.",
  reason: "Not saved: pick a reason.",
  reason_text: "Not saved: say why when the reason is Other.",
  date: "Not saved: the new follow-up date must be after today.",
  no_undo: "Nothing to undo: the prospect has been changed since that decision.",
};
export const DECISION_SAVED: Record<string, string> = {
  closed: "Not following up: moved to Dead and its reminders stopped.",
  later: "Follow-up moved. Reminders pause until that day.",
  undone: "Undone: the stage and follow-up date are back as they were.",
};

export type NotFollowingUpReason = (typeof NOT_FOLLOWING_UP_REASONS)[number]["key"];

export const REASON_LABEL: Record<string, string> = Object.fromEntries(NOT_FOLLOWING_UP_REASONS.map((r) => [r.key, r.label]));
export const isReason = (v: unknown): v is NotFollowingUpReason => typeof v === "string" && Object.hasOwn(REASON_LABEL, v);
