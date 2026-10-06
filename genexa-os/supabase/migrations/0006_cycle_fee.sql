-- The fee a client actually pays per billing cycle is the stored fact
-- ($5,000 for a 90-day deal). monthly_fee is derived from it, so the renewal
-- amount is exact and MRR never carries a rounding error back into it.
drop view renewals;

alter table clients add column cycle_fee numeric(12,2);
-- Existing rows were imported as a rounded monthly figure (1667 = 5000 / 3).
update clients set cycle_fee = case when billing_cycle = '90' then round(monthly_fee * 3, -1) else monthly_fee end;
alter table clients drop column monthly_fee;
alter table clients add column monthly_fee numeric(12,2)
  generated always as (case when billing_cycle = '90' then round(cycle_fee / 3, 2) else cycle_fee end) stored;

-- Renewal amount = the cycle fee. Never estimated any other way.
create view renewals with (security_invoker = true) as
with base as (
  select
    c.id as client_id, c.name, c.stage, c.billing_cycle, c.cycle_fee, c.monthly_fee, c.launch_date,
    case c.billing_cycle when '30' then 30 when 'legacy' then 30 when '90' then 90 end as cycle_days,
    case c.billing_cycle when '30' then 1 when 'legacy' then 1 when '90' then 3 end as cycle_months,
    app_today() as today
  from clients c
  where c.deleted_at is null and c.stage <> 'churned'
),
k as (
  select base.*,
    case when launch_date is not null and cycle_days is not null
      then greatest(floor((today - launch_date)::numeric / cycle_days), 0)::int end as cycles_done
  from base
),
d as (
  select k.*,
    case when cycles_done >= 1 then launch_date + cycles_done * cycle_days end as last_renewal_date,
    case when cycles_done is not null then launch_date + (cycles_done + 1) * cycle_days end as next_renewal_date
  from k
),
p as (
  select d.*,
    exists (
      select 1 from payments pay
      where pay.client_id = d.client_id and pay.classified
        and app_day(pay.paid_at) >= d.last_renewal_date - 5
        and app_day(pay.paid_at) < d.next_renewal_date - 5
    ) as last_paid,
    exists (
      select 1 from payments pay
      where pay.client_id = d.client_id and pay.classified
        and app_day(pay.paid_at) >= d.next_renewal_date - 5
    ) as next_paid
  from d
),
r as (
  select p.*,
    (last_renewal_date is not null and not last_paid) as last_unpaid
  from p
)
select
  client_id, name, stage, billing_cycle, cycle_fee, monthly_fee, launch_date, cycle_months,
  cycle_fee as renewal_amount,
  last_renewal_date,
  next_renewal_date,
  case when last_unpaid then last_renewal_date else next_renewal_date end as renewal_date,
  case when last_unpaid then last_renewal_date else next_renewal_date end - today as days_until,
  case
    when launch_date is null then 'not_started'
    when cycle_days is null then null
    when last_unpaid and today > last_renewal_date then 'overdue'
    when last_unpaid then 'due_7d'
    when next_paid then 'paid'
    when last_renewal_date is not null and today - last_renewal_date <= 5 then 'paid'
    when next_renewal_date - today <= 7 then 'due_7d'
    else 'upcoming'
  end as status
from r;
