-- This week's scores for the people cards.
create function current_week_scores()
returns table (staff_id uuid, card text, metric text, value numeric, numerator numeric, denominator numeric, colour text, is_baseline boolean)
language sql stable as $$
  select s.staff_id, s.card, s.metric, s.value, s.numerator, s.denominator, s.colour, s.is_baseline
  from person_scores_weekly s where s.week_start = app_week_start(app_today())
$$;

-- A person can overrule the test-lead filter. Once reviewed, the filter leaves
-- the lead alone, so the next sync does not flag it again.
alter table leads add column test_reviewed boolean not null default false;

create or replace function leads_test_filter() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text := lower(btrim(coalesce(new.name, '')));
  v_email text := lower(btrim(coalesce(new.email, '')));
  v_local text := split_part(v_email, '@', 1);
  v_domain text := split_part(v_email, '@', 2);
begin
  if new.is_test or new.test_reviewed then return new; end if;
  if v_name ~ '\m(test|tests|testing|tester)\M'
     or v_name ~ '^zz'
     or v_local ~ '(^|[._+-])(test|testing|tester)([._+-]|[0-9]*$)'
     or v_local ~ '^zz'
     or v_domain in ('test.com', 'example.com', 'genexascaling.com')
     or exists (
       select 1 from staff s
       where (v_name <> '' and lower(s.name) = v_name)
          or (v_email <> '' and lower(s.email) = v_email)
     ) then
    new.is_test := true;
  end if;
  return new;
end $$;
