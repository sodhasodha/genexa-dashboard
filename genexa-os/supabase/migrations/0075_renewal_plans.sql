-- Renewals are kept by hand, not synced to Whop (replaces the Whop-backed views of 0074).
-- Each row is a subscription the owner tracks under a client: what it is, how often it renews,
-- how much, when it is next due and its status. The owner adds, edits, marks renewed and
-- removes them. Nothing is deleted: "remove" sets archived_at. renewal_overrides (0074) is no
-- longer read and is left in place for its history.
drop view renewal_clients_all;
drop view renewal_clients;
drop view renewal_subscriptions;

create table renewal_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  every_days integer not null check (every_days between 1 and 366),
  amount numeric(12,2) not null check (amount >= 0),
  next_due date not null,
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelling', 'ended')),
  note text check (length(note) <= 2000),
  archived_at timestamptz,
  created_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index renewal_plans_client_idx on renewal_plans (client_id) where archived_at is null;

create trigger renewal_plans_set_updated_at before update on renewal_plans for each row execute function set_updated_at();
create trigger renewal_plans_forbid_delete before delete on renewal_plans for each row execute function forbid_delete();
create trigger renewal_plans_audit after insert or update on renewal_plans for each row execute function audit_row();
alter table renewal_plans enable row level security;
create policy owner_all on renewal_plans for all to authenticated using (app_is_owner()) with check (app_is_owner());
revoke all on renewal_plans from anon;
grant select, insert, update on renewal_plans to authenticated;
grant all on renewal_plans to service_role;

-- Per client with at least one subscription on the page: the soonest-due subscription that has
-- not ended sets the cycle (next due minus its frequency); spend and revenue are summed for that
-- cycle (its start to today) and since launch. Est. profit = revenue - spend - 30% of revenue.
create view renewal_clients with (security_invoker = true) as
with plans as (
  select * from renewal_plans where archived_at is null
),
running as (
  select distinct on (client_id) client_id, next_due, next_due - every_days as cycle_start
  from plans where status <> 'ended'
  order by client_id, next_due
),
perf as (
  select c.id as client_id,
    sum(p.spend) filter (where p.day >= r.cycle_start) as cycle_spend,
    sum(p.revenue) filter (where p.day >= r.cycle_start) as cycle_revenue,
    sum(p.spend) filter (where p.day >= coalesce(c.launch_date, '-infinity'::date)) as launch_spend,
    sum(p.revenue) filter (where p.day >= coalesce(c.launch_date, '-infinity'::date)) as launch_revenue
  from clients c
  left join running r on r.client_id = c.id
  join client_performance_daily p on p.client_id = c.id and p.day <= app_today()
  where c.id in (select client_id from plans)
  group by c.id
)
select c.id as client_id, c.name as client, c.stage, c.launch_date, r.next_due, r.cycle_start,
  (c.id in (select client_id from clients_ads_unverified)) as ads_unverified, (c.cortana_business_id is null) as no_cortana,
  case when r.client_id is null then null else coalesce(p.cycle_spend, 0) end as cycle_spend,
  case when r.client_id is null then null else coalesce(p.cycle_revenue, 0) end as cycle_revenue,
  coalesce(p.launch_spend, 0) as launch_spend, coalesce(p.launch_revenue, 0) as launch_revenue,
  case when r.client_id is null then null
    else round(coalesce(p.cycle_revenue, 0) - coalesce(p.cycle_spend, 0) - 0.3 * coalesce(p.cycle_revenue, 0), 2) end as cycle_profit,
  round(coalesce(p.launch_revenue, 0) - coalesce(p.launch_spend, 0) - 0.3 * coalesce(p.launch_revenue, 0), 2) as launch_profit
from clients c
left join running r on r.client_id = c.id
left join perf p on p.client_id = c.id
where c.deleted_at is null and c.id in (select client_id from plans);
