-- not_ours -> the patient didn't come from Genexa's ads (walk-in, podcast, referral). Never texted about, or the
-- manager said so; nothing more is asked.
alter table outcome_asks drop constraint if exists outcome_asks_status_check;
alter table outcome_asks add constraint outcome_asks_status_check
  check (status in ('asked', 'reminded', 'logged', 'thinking', 'thinking_asked', 'done', 'unsent', 'not_ours'));
