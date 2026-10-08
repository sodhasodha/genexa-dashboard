-- A new Whop customer paying for a Genexa product becomes a client on their
-- own: client (stage onboarding) + launch (Paid, paid_at = the payment time).
-- "New" means the customer's first paid Genexa payment is on or after the
-- switch-on time. An older customer we merely failed to match is an existing
-- client, so they stay in Data review -> Unmatched payments instead.
insert into app_settings (key, value) values ('whop_new_client_from', to_jsonb(now()))
on conflict (key) do nothing;

create function whop_create_new_clients()
returns table (client_id uuid, name text, amount numeric, paid_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_from timestamptz := (select (value #>> '{}')::timestamptz from app_settings where key = 'whop_new_client_from');
  v_prefix text := coalesce((select value #>> '{}' from app_settings where key = 'whop_mrr_product_prefix'), '');
  u record;
  v_client uuid;
  v_name text;
  v_n integer;
begin
  if v_from is null then return; end if;
  perform set_config('app.actor', 'whop-sync', true);
  for u in
    select p.whop_user_id,
      min(p.paid_at) as first_paid,
      (array_agg(p.amount order by p.paid_at))[1] as first_amount,
      (array_agg(nullif(btrim(p.customer_name), '') order by p.paid_at desc) filter (where nullif(btrim(p.customer_name), '') is not null))[1] as customer
    from payments p
    where p.status = 'paid' and p.amount > 0 and p.whop_user_id is not null
      and p.product_title ilike v_prefix || '%'
    group by p.whop_user_id
    having bool_and(p.client_id is null) and min(p.paid_at) >= v_from
  loop
    -- Someone already attached this customer to a client: nothing to create.
    if exists (select 1 from clients c where u.whop_user_id = any(c.whop_customer_ids)) then continue; end if;
    v_name := coalesce(u.customer, 'New Whop customer');
    -- Never a second client under a name that is already taken.
    select count(*) into v_n from clients c where lower(c.name) = lower(v_name) and c.deleted_at is null;
    if v_n > 0 then v_name := v_name || ' (Whop ' || to_char(u.first_paid at time zone 'America/New_York', 'DD Mon') || ')'; end if;

    insert into clients (name, contact_name, stage, whop_customer_ids, billing_cycle, cycle_fee)
    select v_name, u.customer, 'onboarding', array[u.whop_user_id],
      (select case m.billing_period_days when 30 then '30' when 90 then '90' else 'legacy' end
         from whop_memberships m where m.whop_user_id = u.whop_user_id and m.valid and m.billing_period_days > 0
         order by m.started_at desc limit 1),
      coalesce((select m.renewal_price from whop_memberships m where m.whop_user_id = u.whop_user_id and m.valid and m.renewal_price is not null
                 order by m.started_at desc limit 1), u.first_amount)
    returning id into v_client;
    insert into launches (client_id, paid_at, owner_id) values (v_client, u.first_paid, app_role_holder('tech'));
    update payments set client_id = v_client where whop_user_id = u.whop_user_id and client_id is null;
    update whop_memberships set client_id = v_client where whop_user_id = u.whop_user_id and client_id is null;

    client_id := v_client; name := v_name; amount := u.first_amount; paid_at := u.first_paid;
    return next;
  end loop;
end $$;
revoke execute on function whop_create_new_clients() from public, anon, authenticated;
grant execute on function whop_create_new_clients() to service_role;
