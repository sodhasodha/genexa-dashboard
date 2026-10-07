-- One scorecard view for every role: EODs + tech + media buyer.
create or replace view person_scores_weekly with (security_invoker = true) as
select
  s.staff_id, s.week_start, s.card, s.metric, s.value, s.numerator, s.denominator, s.colour,
  coalesce(s.week_start = app_week_start(
    (select (value #>> '{}')::date from app_settings where key = 'go_live_date')), false) as is_baseline
from (
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_eods_weekly
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_tech_weekly
  union all
  select staff_id, week_start, card, metric, value, numerator, denominator, colour from score_media_weekly
) s;
