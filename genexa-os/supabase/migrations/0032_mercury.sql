-- Mercury bank transactions, categorised by rules the owner can edit.
alter table finance_transactions add column kind text;
alter table finance_transactions add column description text;
alter table finance_transactions add column mercury_category text;
-- 'rule' = set by a finance rule; 'manual' = set by a person and never overwritten.
alter table finance_transactions add column categorised_by text check (categorised_by in ('rule', 'manual'));
alter table finance_rules add column direction text not null default 'any' check (direction in ('in', 'out', 'any'));

-- Starting rules, from the brief and from what the account actually contains.
-- Money in is positive, money out negative. Lower priority number wins.
insert into finance_rules (priority, direction, match_field, pattern, category, included, note) values
  (10, 'any', 'counterparty', 'Mercury Credit',   'excluded', false, 'Card autopay: the card charges themselves are the expenses'),
  (10, 'any', 'counterparty', 'Mercury Checking', 'excluded', false, 'Internal transfer'),
  (10, 'any', 'counterparty', 'Mercury Savings',  'excluded', false, 'Internal transfer'),
  (10, 'in',  'counterparty', 'Mercury IO Cashback', 'excluded', false, 'Card cashback, not revenue'),
  (20, 'in',  'counterparty', 'Whop',             'revenue',  true,  'Whop payouts'),
  (20, 'in',  'counterparty', 'RAY MEDIA',        'excluded', false, 'Cold SMS venture payout, not Genexa'),
  (20, 'in',  'counterparty', 'FanBasis',         'excluded', false, 'Cold SMS venture payout, not Genexa'),
  (30, 'out', 'counterparty', 'Wise',             'payroll',  true,  'Team pay goes out through Wise'),
  (30, 'out', 'counterparty', 'Facebook',         'ads',      true,  'Meta ads'),
  (30, 'out', 'counterparty', 'HighLevel',        'software', true,  null),
  (30, 'out', 'counterparty', 'Anthropic',        'software', true,  null),
  (30, 'out', 'counterparty', 'Telnyx',           'software', true,  null),
  (30, 'out', 'counterparty', 'Google Workspace', 'software', true,  null),
  (30, 'out', 'counterparty', 'Slack',            'software', true,  null),
  (30, 'out', 'counterparty', 'Make',             'software', true,  null),
  (30, 'out', 'counterparty', 'Zoom',             'software', true,  null),
  (30, 'out', 'counterparty', 'Fixie',            'software', true,  null),
  (30, 'out', 'counterparty', 'Retell AI',        'software', true,  null),
  (30, 'out', 'counterparty', 'Intl. Transaction Fee', 'other', true, 'Bank fees'),
  (40, 'out', 'counterparty', 'PayPal',           'personal', false, 'Personal (confirmed 6 Oct 2026)'),
  (40, 'out', 'counterparty', 'Temu',             'personal', false, 'Personal (confirmed 6 Oct 2026)'),
  (40, 'out', 'counterparty', 'Amazon',           'personal', false, 'Personal (confirmed 6 Oct 2026)'),
  (40, 'out', 'counterparty', 'ACORNFIRE',        'personal', false, 'Personal (confirmed 6 Oct 2026)');

-- Categorise everything a person has not categorised by hand. The first
-- enabled rule (lowest priority number) whose pattern appears in the field wins.
create function apply_finance_rules() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with pick as (
    select distinct on (t.id) t.id, r.category, r.included
    from finance_transactions t
    join finance_rules r on r.enabled
      and (r.direction = 'any' or (r.direction = 'in' and t.amount > 0) or (r.direction = 'out' and t.amount < 0))
      and lower(case r.match_field when 'counterparty' then coalesce(t.counterparty, '')
                                   when 'description' then coalesce(t.description, '')
                                   else coalesce(t.kind, '') end) like '%' || lower(r.pattern) || '%'
    where t.categorised_by is distinct from 'manual'
    order by t.id, r.priority, r.created_at
  )
  update finance_transactions t
  set category = pick.category, included = pick.included, categorised_by = 'rule'
  from pick
  where t.id = pick.id and (t.category is distinct from pick.category or t.included is distinct from pick.included or t.categorised_by is null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function apply_finance_rules() from public, anon;
grant execute on function apply_finance_rules() to authenticated, service_role;

-- Overview totals: expenses are money out in the business categories. Team pay
-- comes from approved pay runs when there are any in the period, otherwise from
-- the bank's payroll category, so pay is never counted twice.
create or replace function overview_period(p_from date, p_to date)
returns table (
  ad_spend numeric, leads numeric, booked numeric, confirmed numeric, shows numeric, no_shows numeric,
  closes numeric, clinic_revenue numeric, cash_collected numeric, expenses numeric, bank_revenue numeric)
language sql stable as $$
  select
    (select sum(d.spend) from ad_metrics_daily d
      where d.date between p_from and p_to
        and d.client_id not in (select u.client_id from clients_ads_unverified u)),
    f.leads, f.booked, f.confirmed, f.shows, f.no_shows, f.closes, f.clinic_revenue,
    (select coalesce(sum(pay.amount), 0) from payments pay
      where pay.classified and pay.status = 'paid' and app_day(pay.paid_at) between p_from and p_to),
    b.other_out + coalesce(payroll_cost(p_from, p_to), b.payroll_out),
    b.revenue_in
  from (
    select coalesce(sum(leads), 0)::numeric as leads, coalesce(sum(booked), 0)::numeric as booked,
      coalesce(sum(confirmed), 0)::numeric as confirmed, coalesce(sum(shows), 0)::numeric as shows,
      coalesce(sum(no_shows), 0)::numeric as no_shows, coalesce(sum(closes), 0)::numeric as closes,
      coalesce(sum(revenue), 0) as clinic_revenue
    from client_funnel_period(p_from, p_to)
  ) f,
  (
    select
      sum(-t.amount) filter (where t.amount < 0 and t.category in ('ads', 'software', 'other')) as other_out,
      coalesce(sum(-t.amount) filter (where t.amount < 0 and t.category = 'payroll'), 0) as payroll_out,
      sum(t.amount) filter (where t.amount > 0 and t.category = 'revenue') as revenue_in
    from finance_transactions t
    where t.included and app_day(t.posted_at) between p_from and p_to
  ) b
$$;
