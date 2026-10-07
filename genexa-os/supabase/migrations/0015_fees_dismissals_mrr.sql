-- Fees from Whop, dismissable review items, per-payment client override, MRR history.

-- A payment a person has assigned to a specific client keeps that client,
-- even when the customer as a whole belongs to another one.
alter table payments add column client_locked boolean not null default false;

-- A fee the owner has confirmed by hand is kept; otherwise a matched client's
-- fee follows their live Whop plan.
alter table clients add column fee_locked boolean not null default false;
alter table clients add column fee_note text;

-- ---------------------------------------------------------------------------
-- What each client pays per month, and where that figure comes from.
--   whop    = sum of the client's live recurring Whop memberships, as a 30-day figure
--   record  = the fee on the client record (cycle_fee / months in cycle)
-- Effective fee: the record if the owner locked it, else Whop when there is a
-- live recurring membership, else the record.
-- ---------------------------------------------------------------------------
create view client_fees with (security_invoker = true) as
with w as (
  select m.client_id,
    round(sum(m.renewal_price / m.billing_period_days * 30), 2) as whop_monthly,
    count(*) as memberships,
    string_agg('$' || m.renewal_price || ' every ' || m.billing_period_days || ' days', ' + ' order by m.renewal_price desc) as whop_plans
  from whop_memberships m
  where m.client_id is not null and m.valid and m.billing_period_days > 0 and m.renewal_price is not null
  group by m.client_id
)
select
  c.id as client_id, c.name, c.stage, c.billing_cycle, c.cycle_fee, c.fee_locked,
  c.monthly_fee as record_monthly,
  w.whop_monthly,
  w.whop_plans,
  case when c.fee_locked then c.monthly_fee when w.whop_monthly is not null then w.whop_monthly else c.monthly_fee end as monthly_fee,
  case when c.fee_locked then 'confirmed' when w.whop_monthly is not null then 'whop' else 'record' end as source,
  (not c.fee_locked and w.whop_monthly is not null
    and (c.monthly_fee is null or abs(w.whop_monthly - c.monthly_fee) > 1)) as mismatch
from clients c
left join w on w.client_id = c.id
where c.deleted_at is null and c.stage <> 'churned';

-- Recurring MRR on a given day, straight from Whop memberships: every renewing
-- membership that had started and had not ended. Used for month-on-month history.
create function whop_mrr_at(p_day date) returns numeric
language sql stable as $$
  select coalesce(round(sum(m.renewal_price / m.billing_period_days * 30), 2), 0)
  from whop_memberships m
  where m.billing_period_days > 0 and m.renewal_price is not null
    and app_day(m.started_at) <= p_day
    and (
      (m.valid and (m.renewal_period_end is null or app_day(m.renewal_period_end) >= p_day or p_day >= app_today()))
      or (not m.valid and m.renewal_period_end is not null and app_day(m.renewal_period_end) > p_day)
    )
$$;

-- ---------------------------------------------------------------------------
-- Dismissing a review item (with a reason). Nothing is deleted: the item is
-- just hidden, and the dismissal is its own audited record.
-- ---------------------------------------------------------------------------
create table data_review_dismissals (
  id uuid primary key default gen_random_uuid(),
  item_key text not null unique,
  kind text not null,
  title text not null,
  reason text not null check (btrim(reason) <> ''),
  dismissed_by uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger data_review_dismissals_set_updated_at before update on data_review_dismissals for each row execute function set_updated_at();
create trigger data_review_dismissals_forbid_delete before delete on data_review_dismissals for each row execute function forbid_delete();
create trigger data_review_dismissals_audit after insert or update on data_review_dismissals for each row execute function audit_row();
alter table data_review_dismissals enable row level security;
create policy owner_all on data_review_dismissals for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on data_review_dismissals for select to authenticated using (app_staff_id() is not null);

-- The queue people work from: every review item not yet dismissed, with fee
-- mismatches taken from client_fees (monthly figures compared like for like,
-- so $2,000 every 45 days equals $4,000 every 90).
create view data_review_open with (security_invoker = true) as
with items as (
  select i.kind, i.record_table, i.record_id, i.client_id, i.title, i.detail, i.occurred_at
  from data_review_items i
  where not (i.kind = 'anomaly' and i.title like '%fee on record%')
  union all
  select 'anomaly', 'client_fees', f.client_id, f.client_id,
    f.name || ' · fee on record ' || coalesce('$' || f.record_monthly || '/month', 'missing') || ', Whop charges $' || f.whop_monthly || '/month',
    'Whop: ' || f.whop_plans || '. MRR uses the Whop figure until you confirm one.',
    now()
  from client_fees f where f.mismatch
)
select items.*, items.kind || ':' || items.record_id || ':' || md5(items.title) as item_key
from items
where not exists (
  select 1 from data_review_dismissals d
  where d.item_key = items.kind || ':' || items.record_id || ':' || md5(items.title));

-- Fee confirmed by the owner in conversation on 7 Oct 2026.
update clients set cycle_fee = 3000, fee_locked = true,
  fee_note = 'Two locations: $2,000 + $1,000 per month (confirmed by Ryan, 7 Oct 2026)'
where lower(name) = 'vitale health clinic';
update clients set fee_locked = true,
  fee_note = '$4,000 per 90 days; Whop collects it as $2,000 every 45 days (confirmed by Ryan, 7 Oct 2026)'
where lower(name) = 'quantum medical & wellness center';
