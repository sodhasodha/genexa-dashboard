-- "New task · from Slack", not "from request-router", for tasks the request router made.
do $$
declare def text;
begin
  def := pg_get_functiondef('reminder_candidates(timestamptz)'::regprocedure);
  if position($q$'assigned_by', case when a.actor = 'system' then initcap(t.source) else a.actor end$q$ in def) = 0 then
    raise exception 'task_assigned assigned_by not found in reminder_candidates';
  end if;
  execute replace(def,
    $q$'assigned_by', case when a.actor = 'system' then initcap(t.source) else a.actor end$q$,
    $q$'assigned_by', case when a.actor in ('system', 'request-router') then initcap(t.source) else a.actor end$q$);
end $$;
