-- Decisions a person makes about Whop records must survive the next sync.

-- A membership assigned to a specific client keeps it (one customer, two clinics).
alter table whop_memberships add column client_locked boolean not null default false;

-- A payment with no Whop product (a rev share invoice, a one-off link) is
-- unclassified until a person says what it was. Their label is kept here and
-- the sync writes it back as the product title.
alter table payments add column title_override text;

insert into app_settings (key, value) values ('whop_mrr_product_prefix', '"Genexa Scaling"')
on conflict (key) do nothing;

-- Recurring MRR on a day from Whop memberships, Genexa products only
-- (older products on the same Whop account belong to other businesses).
create or replace function whop_mrr_at(p_day date) returns numeric
language sql stable as $$
  select coalesce(round(sum(m.renewal_price / m.billing_period_days * 30), 2), 0)
  from whop_memberships m
  where m.billing_period_days > 0 and m.renewal_price is not null
    and m.product_title ilike (select (value #>> '{}') from app_settings where key = 'whop_mrr_product_prefix') || '%'
    and app_day(m.started_at) <= p_day
    and (
      (m.valid and (m.renewal_period_end is null or app_day(m.renewal_period_end) >= p_day or p_day >= app_today()))
      or (not m.valid and m.renewal_period_end is not null and app_day(m.renewal_period_end) > p_day)
    )
$$;

-- Review queue: add paid payments nobody has classified.
create or replace view data_review_open with (security_invoker = true) as
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
  union all
  select 'unclassified_payment', 'payments', p.id, p.client_id,
    coalesce(c.name, p.customer_name, 'Unknown customer') || ' · $' || p.amount,
    'Paid ' || to_char(p.paid_at at time zone 'America/New_York', 'DD Mon') || ' with no Whop product. Not counted as cash collected until you say what it was.',
    p.paid_at
  from payments p left join clients c on c.id = p.client_id
  where p.status = 'paid' and not p.classified
)
select items.*, items.kind || ':' || items.record_id || ':' || md5(items.title) as item_key
from items
where not exists (
  select 1 from data_review_dismissals d
  where d.item_key = items.kind || ':' || items.record_id || ':' || md5(items.title));
