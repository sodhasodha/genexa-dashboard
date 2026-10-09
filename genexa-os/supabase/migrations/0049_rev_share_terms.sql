-- Rev share is per clinic, not one rate for everyone:
--   percent      a share of the clinic revenue Cortana records (the default, 5% unless the clinic has its own rate)
--   per_patient  a fixed amount for each new paying patient
--   none         no rev share collected
alter table clients add column rev_share_type text not null default 'percent' check (rev_share_type in ('percent', 'per_patient', 'none'));
alter table clients add column rev_share_rate numeric(6,4) check (rev_share_rate is null or (rev_share_rate >= 0 and rev_share_rate <= 1));
alter table clients add column rev_share_per_patient numeric(12,2) check (rev_share_per_patient is null or rev_share_per_patient >= 0);
alter table clients add constraint clients_rev_share_per_patient_set
  check (rev_share_type <> 'per_patient' or rev_share_per_patient is not null);

update clients set rev_share_type = 'none'
where name in ('Dr Darren - Pivotal Health (Lake Worth)', 'Multivita IV');
update clients set rev_share_type = 'per_patient', rev_share_per_patient = 150
where name in ('Reviv Florida', 'Regen RX');

-- What each clinic owes for a period. A "new paying patient" is a patient whose
-- FIRST purchase at that clinic falls in the period, so a patient who pays in
-- instalments is charged for once. Test contacts and unverified clinics are left out,
-- exactly as in the Overview's clinic revenue.
create function rev_share_period(p_from date, p_to date)
returns table (client_id uuid, name text, rev_share_type text, terms text, revenue numeric, new_patients bigint, owed numeric)
language sql stable as $$
  with firsts as (
    select e.client_id, e.contact_id, min(e.occurred_at) as first_at
    from cortana_events e
    where not e.is_test and e.event = 'purchase'
    group by e.client_id, e.contact_id
  ),
  p as (
    select c.id as client_id, c.name, c.rev_share_type,
      coalesce(c.rev_share_rate, config_value('rev_share_rate')) as rate, c.rev_share_per_patient as per_patient,
      (select coalesce(sum(e.value), 0) from cortana_events e
        where e.client_id = c.id and not e.is_test and e.event = 'purchase' and app_day(e.occurred_at) between p_from and p_to) as revenue,
      (select count(*) from firsts f where f.client_id = c.id and app_day(f.first_at) between p_from and p_to) as new_patients
    from clients c
    where c.deleted_at is null and c.id not in (select u.client_id from clients_ads_unverified u)
  )
  select p.client_id, p.name, p.rev_share_type,
    case p.rev_share_type
      when 'none' then 'No rev share'
      when 'per_patient' then '$' || trim(to_char(p.per_patient, 'FM999,999,990.##'), '.') || ' per new paying patient'
      else trim(to_char(p.rate * 100, 'FM990.##'), '.') || '% of clinic revenue'
    end,
    p.revenue, p.new_patients,
    round(case p.rev_share_type when 'none' then 0 when 'per_patient' then p.new_patients * p.per_patient else p.revenue * p.rate end, 2)
  from p
  where p.revenue > 0 or p.new_patients > 0
$$;
grant execute on function rev_share_period(date, date) to authenticated, service_role;
