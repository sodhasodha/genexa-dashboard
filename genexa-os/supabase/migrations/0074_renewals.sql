-- Renewals: every recurring Whop subscription under its client, when it is next due, and how the
-- client is doing this cycle (spend, revenue, ROAS, estimated profit), so the owner knows who to renew.
--
-- The owner can correct a subscription's frequency, next due date and amount. Corrections live
-- here, not on whop_memberships, so the Whop sync never overwrites them; a null field means "use
-- Whop". A corrected due date is only used until Whop's own date moves (the subscription renewed),
-- so an old correction never hides a new cycle. Moving a subscription to another client uses the
-- existing whop_memberships.client_locked (0021).
create table renewal_overrides (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null unique references whop_memberships(id),
  billing_period_days integer check (billing_period_days between 1 and 366),
  next_due date,
  -- Whop's due date when next_due was entered: once Whop's date differs, next_due is ignored.
  next_due_whop_date date,
  amount numeric(12,2) check (amount >= 0),
  note text check (length(note) <= 2000),
  updated_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger renewal_overrides_set_updated_at before update on renewal_overrides for each row execute function set_updated_at();
create trigger renewal_overrides_forbid_delete before delete on renewal_overrides for each row execute function forbid_delete();
create trigger renewal_overrides_audit after insert or update on renewal_overrides for each row execute function audit_row();
alter table renewal_overrides enable row level security;
create policy owner_all on renewal_overrides for all to authenticated using (app_is_owner()) with check (app_is_owner());
revoke all on renewal_overrides from anon;
grant select, insert, update on renewal_overrides to authenticated;
grant all on renewal_overrides to service_role;

-- One row per recurring subscription that belongs to a client. "ended" = cancelled and past its last paid day.
create view renewal_subscriptions with (security_invoker = true) as
with s as (
  select
    m.id as membership_id, m.client_id, c.name as client, m.product_title, m.status, m.valid, m.cancel_at_period_end,
    m.billing_period_days as whop_days, m.renewal_price as whop_amount, app_day(m.renewal_period_end) as whop_due,
    o.billing_period_days as edit_days, o.amount as edit_amount, o.note,
    case when o.next_due is not null and o.next_due_whop_date is not distinct from app_day(m.renewal_period_end) then o.next_due end as edit_due,
    (o.next_due is not null and o.next_due_whop_date is distinct from app_day(m.renewal_period_end)) as edit_due_expired
  from whop_memberships m
  join clients c on c.id = m.client_id and c.deleted_at is null
  left join renewal_overrides o on o.membership_id = m.id
  where coalesce(o.billing_period_days, m.billing_period_days) is not null
)
select s.*,
  coalesce(s.edit_days, s.whop_days) as every_days,
  coalesce(s.edit_amount, s.whop_amount) as amount,
  coalesce(s.edit_due, s.whop_due) as next_due,
  coalesce(s.edit_due, s.whop_due) - coalesce(s.edit_days, s.whop_days) as cycle_start,
  case
    when s.status = 'past_due' then 'past_due'
    when s.valid and not s.cancel_at_period_end then 'active'
    when coalesce(s.edit_due, s.whop_due) >= app_today() then 'cancelling'
    else 'ended'
  end as state
from s;

-- Per client: the soonest-due running subscription sets the cycle; spend and revenue are summed for
-- that cycle (its start to today) and since launch. Est. profit = revenue - spend - 30% of revenue.
create view renewal_clients with (security_invoker = true) as
with running as (
  select distinct on (client_id) client_id, next_due, cycle_start
  from renewal_subscriptions where state <> 'ended'
  order by client_id, next_due nulls last
),
perf as (
  select r.client_id,
    sum(p.spend) filter (where p.day >= r.cycle_start) as cycle_spend,
    sum(p.revenue) filter (where p.day >= r.cycle_start) as cycle_revenue,
    sum(p.spend) filter (where p.day >= coalesce(c.launch_date, '-infinity'::date)) as launch_spend,
    sum(p.revenue) filter (where p.day >= coalesce(c.launch_date, '-infinity'::date)) as launch_revenue
  from running r
  join clients c on c.id = r.client_id
  join client_performance_daily p on p.client_id = r.client_id and p.day <= app_today()
  group by r.client_id
)
select r.client_id, c.name as client, c.stage, c.launch_date, r.next_due, r.cycle_start,
  (c.id in (select client_id from clients_ads_unverified)) as ads_unverified, (c.cortana_business_id is null) as no_cortana,
  coalesce(p.cycle_spend, 0) as cycle_spend, coalesce(p.cycle_revenue, 0) as cycle_revenue,
  coalesce(p.launch_spend, 0) as launch_spend, coalesce(p.launch_revenue, 0) as launch_revenue,
  round(coalesce(p.cycle_revenue, 0) - coalesce(p.cycle_spend, 0) - 0.3 * coalesce(p.cycle_revenue, 0), 2) as cycle_profit,
  round(coalesce(p.launch_revenue, 0) - coalesce(p.launch_spend, 0) - 0.3 * coalesce(p.launch_revenue, 0), 2) as launch_profit
from running r
join clients c on c.id = r.client_id
left join perf p on p.client_id = r.client_id;

-- Clients with only ended subscriptions still show (no cycle, no figures), so "Show ended" has a client row.
create view renewal_clients_all with (security_invoker = true) as
select * from renewal_clients
union all
select distinct c.id, c.name, c.stage, c.launch_date, null::date, null::date,
  (c.id in (select client_id from clients_ads_unverified)), (c.cortana_business_id is null), null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric
from renewal_subscriptions r join clients c on c.id = r.client_id
where r.client_id not in (select client_id from renewal_clients);
