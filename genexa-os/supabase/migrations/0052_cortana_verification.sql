-- Cortana is the record of each clinic's results. Genexa OS keeps a copy, and
-- the copy is checked against Cortana every day and corrected:
--   * an event Cortana has and we do not is added;
--   * an event whose time, type or value changed in Cortana is updated;
--   * an event Cortana no longer has (deleted or merged there) stops counting here;
--   * a day whose ad spend differs is read again.
-- Each check is written down in cortana_checks so a difference is visible.

-- Events Cortana no longer has are moved here, not destroyed: nothing is lost,
-- and every view that counts cortana_events is right without changing any of them.
create table cortana_events_removed (
  id uuid primary key,
  client_id uuid not null references clients(id),
  cortana_entry_id text not null,
  event text not null,
  occurred_at timestamptz not null,
  value numeric(12,2),
  contact_id text not null,
  contact_first_name text,
  is_test boolean not null,
  attribution_source text,
  campaign_id text,
  campaign_name text,
  ad_id text,
  ad_name text,
  contact_key text,
  synced_at timestamptz,
  removed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cortana_events_removed_client_idx on cortana_events_removed (client_id, occurred_at);
create trigger cortana_events_removed_forbid_delete before delete on cortana_events_removed for each row execute function forbid_delete();
alter table cortana_events_removed enable row level security;
create policy owner_all on cortana_events_removed for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on cortana_events_removed for select to authenticated using (app_staff_id() is not null);
grant select on cortana_events_removed to authenticated, service_role;

-- A row leaves cortana_events only through the function below.
create function cortana_events_delete_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.cortana_archiving', true), '') = '1' then return old; end if;
  raise exception 'Hard deletes are not allowed on %', tg_table_name using errcode = 'P0001';
end $$;
drop trigger cortana_events_forbid_delete on cortana_events;
create trigger cortana_events_forbid_delete before delete on cortana_events for each row execute function cortana_events_delete_guard();

create function cortana_events_archive(p_client uuid, p_entry_ids text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into cortana_events_removed (id, client_id, cortana_entry_id, event, occurred_at, value, contact_id, contact_first_name, is_test,
    attribution_source, campaign_id, campaign_name, ad_id, ad_name, contact_key, synced_at)
  select e.id, e.client_id, e.cortana_entry_id, e.event, e.occurred_at, e.value, e.contact_id, e.contact_first_name, e.is_test,
    e.attribution_source, e.campaign_id, e.campaign_name, e.ad_id, e.ad_name, e.contact_key, e.synced_at
  from cortana_events e
  where e.client_id = p_client and e.cortana_entry_id = any(p_entry_ids)
  on conflict (id) do nothing;
  perform set_config('app.cortana_archiving', '1', true);
  delete from cortana_events e where e.client_id = p_client and e.cortana_entry_id = any(p_entry_ids);
  get diagnostics n = row_count;
  perform set_config('app.cortana_archiving', '', true);
  return n;
end $$;
revoke execute on function cortana_events_archive(uuid, text[]) from public, anon, authenticated;
grant execute on function cortana_events_archive(uuid, text[]) to service_role;

create table cortana_checks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  checked_at timestamptz not null default now(),
  events_from date not null,
  spend_from date not null,
  spend_to date not null,
  spend_ours numeric(12,2),
  spend_cortana numeric(12,2),
  spend_days_reread integer not null default 0,
  events_cortana integer,
  events_added integer not null default 0,
  events_changed integer not null default 0,
  events_removed integer not null default 0,
  -- true = our copy matched Cortana before anything was corrected
  matched boolean not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cortana_checks_client_idx on cortana_checks (client_id, checked_at desc);
create trigger cortana_checks_forbid_delete before delete on cortana_checks for each row execute function forbid_delete();
alter table cortana_checks enable row level security;
create policy owner_all on cortana_checks for all to authenticated using (app_is_owner()) with check (app_is_owner());
create policy staff_read on cortana_checks for select to authenticated using (app_staff_id() is not null);
grant select on cortana_checks to authenticated, service_role;

-- The latest check per clinic, and what the checks corrected in the last 7 days.
create view cortana_check_latest with (security_invoker = true) as
select distinct on (k.client_id)
  k.client_id, c.name, k.checked_at, k.matched, k.error, k.spend_ours, k.spend_cortana, k.spend_from, k.spend_to, k.events_cortana, k.events_from,
  w.added_7d, w.changed_7d, w.removed_7d, w.days_reread_7d
from cortana_checks k
join clients c on c.id = k.client_id and c.deleted_at is null
cross join lateral (
  select coalesce(sum(x.events_added), 0)::int as added_7d, coalesce(sum(x.events_changed), 0)::int as changed_7d,
    coalesce(sum(x.events_removed), 0)::int as removed_7d, coalesce(sum(x.spend_days_reread), 0)::int as days_reread_7d
  from cortana_checks x where x.client_id = k.client_id and x.checked_at > now() - interval '7 days'
) w
order by k.client_id, k.checked_at desc;
grant select on cortana_check_latest to authenticated, service_role;
