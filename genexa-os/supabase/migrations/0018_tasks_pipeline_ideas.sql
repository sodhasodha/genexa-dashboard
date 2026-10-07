-- Phase 9 pages: Tasks, Pipeline, Ideas.
-- Reads only. The task rules themselves live in tasks_rules (0002) and are unchanged.

-- ---------------------------------------------------------------------------
-- Tasks as the page shows them: live rows only, with the clinic name, the parent's
-- title, days overdue (ET) and, for done tasks, their position newest-first.
--   days_overdue: due date before today in ET and the task is not done. Null otherwise.
--   done_rank:    1 = most recently done on that owner's list. Null unless in the Done group.
-- ---------------------------------------------------------------------------
create view task_list with (security_invoker = true) as
select
  t.id, t.owner_id, t.parent_task_id,
  p.title as parent_title,
  t.title, t.client_id,
  c.name as client_name,
  t.category, t.priority,
  case t.priority when 'high' then 1 when 'medium' then 2 else 3 end as priority_rank,
  t.due,
  case when t.status <> 'done' and t.due < app_today() then app_today() - t.due end as days_overdue,
  t.status, t.task_group, t.source, t.notes,
  t.done_at,
  app_day(t.done_at) as done_day,
  case when t.task_group = 'done' then
    row_number() over (partition by t.owner_id, t.task_group order by t.done_at desc nulls last, t.updated_at desc, t.id)
  end as done_rank,
  t.created_at
from tasks t
left join clients c on c.id = t.client_id
left join tasks p on p.id = t.parent_task_id and p.deleted_at is null
where t.deleted_at is null;

-- One row per person who can hold tasks, with what is open and what is overdue.
create view task_owners with (security_invoker = true) as
select
  s.id as owner_id, s.name, s.role,
  count(t.id) filter (where t.task_group <> 'done') as open_tasks,
  count(t.id) filter (where t.days_overdue is not null) as overdue_tasks,
  count(t.id) filter (where t.task_group = 'done') as done_tasks
from staff s
left join task_list t on t.owner_id = s.id
where s.status <> 'left'
group by s.id, s.name, s.role;

-- ---------------------------------------------------------------------------
-- Pipeline: follow-ups that are late. A prospect is late when its follow-up date is
-- before today in ET and it is still being worked (chase or contract out).
-- Contact details are deliberately not in this view.
-- ---------------------------------------------------------------------------
create view prospect_follow_ups with (security_invoker = true) as
select
  p.id, p.name, p.heat, p.state, p.stage, p.promised, p.follow_up_date, p.deal_size,
  app_today() - p.follow_up_date as days_overdue
from prospects p
where p.deleted_at is null
  and p.stage in ('chase', 'contract_out')
  and p.follow_up_date < app_today();

-- ---------------------------------------------------------------------------
-- Ideas: live rows with the ET day they were added.
-- ---------------------------------------------------------------------------
create view idea_list with (security_invoker = true) as
select i.id, i.text, i.source, i.created_at, app_day(i.created_at) as created_day
from ideas i
where i.deleted_at is null;

-- Any logged-in staff member can add an idea. Editing and soft-deleting stay owner-only
-- (owner_all, 0004): there is no staff update policy on ideas.
create policy staff_insert on ideas for insert to authenticated
  with check (app_staff_id() is not null and deleted_at is null);
