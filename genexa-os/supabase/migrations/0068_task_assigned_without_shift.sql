-- "New task" DMs reach people with no shift entered (Sameer, Aditya). The rule waits
-- for the person's shift, and the queue drops quiet-hours messages for anyone without
-- one, so they never got them. Like task_due_2h and task_overdue: not held when no
-- shift is entered. With a shift it still waits for the start of it.
do $$
declare def text;
begin
  def := pg_get_functiondef('reminder_candidates(timestamptz)'::regprocedure);
  if position($q$select 'task_assigned', t.owner_id, null, 'tasks', t.id, '', false,$q$ in def) = 0 then
    raise exception 'task_assigned arm not found in reminder_candidates';
  end if;
  execute replace(def,
    $q$select 'task_assigned', t.owner_id, null, 'tasks', t.id, '', false,$q$,
    $q$select 'task_assigned', t.owner_id, null, 'tasks', t.id, '', not exists (select 1 from ss where ss.staff_id = t.owner_id and ss.has_shift),$q$);
end $$;

update reminder_rules set timing = 'immediately; held to the start of the shift when the person has one'
where key = 'task_assigned';
