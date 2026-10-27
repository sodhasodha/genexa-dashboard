-- CSRs only use the confirmation desk now (0063): they cannot file EODs or clock
-- in, so they are no longer listed as missing EODs or scored on EODs/attendance.
-- Same view text, with 'csr' taken out of the role list.
do $$
declare v text; def text;
begin
  foreach v in array array['eod_status_7d', 'data_review_items', 'score_eods_weekly', 'score_attendance_weekly'] loop
    def := pg_get_viewdef(v::regclass);
    if position($q$ARRAY['csr'::text, 'tech'::text, 'media_buyer'::text]$q$ in def) = 0 then
      raise exception 'role list not found in %', v;
    end if;
    execute format('create or replace view %I with (security_invoker = true) as %s', v,
      replace(def, $q$ARRAY['csr'::text, 'tech'::text, 'media_buyer'::text]$q$, $q$ARRAY['tech'::text, 'media_buyer'::text]$q$));
  end loop;
end $$;
