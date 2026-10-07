# Genexa OS — MCP endpoint

Lets Claude read the agency's numbers and write to its working lists. 14 read tools, 7 write tools, no delete tools.

## Connect

- **URL:** `https://<APP_URL>/api/mcp` (locally `http://localhost:3000/api/mcp`)
- **Header:** `Authorization: Bearer <MCP_BEARER_TOKEN>` — the value of the `MCP_BEARER_TOKEN` environment variable. No token set = every request is refused (401).
- **Transport:** MCP streamable HTTP. `POST` JSON-RPC 2.0, one message or a batch array; the reply is a single `application/json` body (no SSE). `GET` returns 405. A notification (e.g. `notifications/initialized`) returns 202 with no body.
- **Methods:** `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Protocol versions 2025-06-18, 2025-03-26, 2024-11-05.

Claude Code:

```bash
claude mcp add --transport http genexa-os https://<APP_URL>/api/mcp --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

By hand:

```bash
curl -s https://<APP_URL>/api/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_overview","arguments":{"period":"week"}}}'
```

## How results come back

Every tool returns the same object twice: as `structuredContent` and as a JSON string in `content[0].text`.

```json
{ "jsonrpc": "2.0", "id": 1, "result": {
    "content": [{ "type": "text", "text": "{\"status\":\"not_available\", ...}" }],
    "structuredContent": { "status": "not_available", "...": "..." } } }
```

The examples below show the request `params` and the `structuredContent` only.

- **Numbers are the database's.** Each tool calls one SQL function (`mcp_*`, migration `0028_mcp.sql`) built on the same views the app's pages use. Nothing is recalculated in the endpoint.
- **Null means not known**, never zero. Money is USD. Days are cut in US Eastern time.
- **No patient surnames, phones or emails.** Prospect contact details are never returned and cannot be written.
- **A tool that cannot do what was asked** returns `isError: true` with `{ "error": { "code", "message", ... } }` — not a protocol error. Codes: `NOT_FOUND`, `AMBIGUOUS`, `INVALID`, `TASK_OWNER_LIST`, `TASK_CATEGORY`, `TASK_DELETED_MATCH`, `DATABASE_ERROR`, `INTERNAL_ERROR`.
- **Protocol errors:** unknown method `-32601`; unknown tool or bad arguments `-32602` with a message such as `Invalid arguments for get_scores: week: must be a Monday`; malformed message `-32600`; body not JSON `-32700`.
- **Writes are audited** in `audit_log` with actor `claude`.

## The three task rules

`add_task` checks these in the endpoint before writing, and the database trigger `tasks_rules` enforces them again. Either way the task is not created and the error names the rule.

| Code | Rule |
| --- | --- |
| `TASK_OWNER_LIST` | Ryan's list (the staff member with role `owner`) only accepts `source = "pushpin"`. |
| `TASK_CATEGORY` | The media buyer's tasks must have category `ads` or `call_centre`. |
| `TASK_DELETED_MATCH` | A title that fuzzy-matches (trigram similarity ≥ 0.6, `scoring_config.task_deleted_similarity`) a task that owner deleted is refused. |

```json
{ "error": { "code": "TASK_OWNER_LIST", "message": "Ryan's list only takes tasks with source = pushpin (got claude).",
             "rule": "Ryan's list only accepts tasks with source = pushpin.", "enforced_by": "endpoint" } }
```

---

# Read tools

## get_overview

`period` (optional): `today` | `week` | `month` (default) | `last_month`. Totals for the period and the like-for-like period before it, MRR, open exceptions, clients by stage, source freshness. `history` says how far back ad and event data go: a `previous` figure from before those dates is not a real comparison.

```json
{ "name": "get_overview", "arguments": { "period": "today" } }
```
```json
{ "period": { "key": "today", "label": "Today", "from": "2026-10-07", "to": "2026-10-07",
              "previous_from": "2026-10-06", "previous_to": "2026-10-06", "previous_label": "yesterday" },
  "current":  { "ad_spend": 100, "leads": 2, "booked": 1, "confirmed": 0, "shows": 0, "no_shows": 0, "closes": 0,
                "clinic_revenue": 0, "cash_collected": 3500, "expenses": null, "bank_revenue": null },
  "previous": { "ad_spend": 50, "leads": 0, "booked": 0, "confirmed": 0, "shows": 0, "no_shows": 0, "closes": 0,
                "clinic_revenue": 0, "cash_collected": 0, "expenses": null, "bank_revenue": null },
  "history": { "ad_spend_from": "2026-10-06", "events_from": "2026-10-07" },
  "mrr": { "total": 5500, "clients": 2, "priced_from_whop": 1, "target": 100000 },
  "exceptions": { "open": 1, "money_at_risk": 500 },
  "clients_by_stage": { "live": 1, "onboarding": 1, "churned": 1 },
  "sources": [{ "source": "cortana", "freshness": "fresh" }, { "source": "mercury", "freshness": "never" }] }
```

## get_clients

No arguments. Every non-deleted client, churned last. `fee`, `health` and `renewal` are null for a churned client; `this_month` is null when nothing is recorded this month.

```json
{ "name": "get_clients", "arguments": {} }
```
```json
{ "clients": [{
    "id": "7b0c…", "name": "Alpha Clinic", "stage": "live", "pod": "pod_1", "launch_date": "2026-08-28",
    "health": { "colour": "red", "reasons": "$0 ad spend 24h+" },
    "fee": { "monthly_fee": 3500, "source": "whop" },
    "renewal": { "date": "2026-10-27", "status": "upcoming", "amount": 3500, "days_until": 20, "source": "whop" },
    "this_month": { "month": "2026-10-01", "spend": 150, "leads": 2, "booked": 1, "confirmed": 0, "shows": 0, "closes": 0,
                    "revenue": null, "cpl": 75, "cost_per_booked": 150, "booking_rate": 0.5, "show_rate": null, "roas": null },
    "next_action": "Renewal call Friday", "last_contact_us": "2026-10-05T14:02:11+00:00", "last_reply_client": null,
    "cortana_connected": true, "ads_unverified": false }] }
```

## get_client

`id` (required). The `get_clients` row plus `open_exceptions` (open and snoozed), `tech_jobs` (newest 50) and `recent_touches` (newest 20).

```json
{ "name": "get_client", "arguments": { "id": "7b0c…" } }
```
```json
{ "id": "7b0c…", "name": "Alpha Clinic", "stage": "live", "fee": { "monthly_fee": 3500, "source": "whop" }, "…": "…",
  "open_exceptions": [{ "id": "e41a…", "type": "zero_spend", "severity": "red", "status": "open", "reason": "$0 ad spend 24h+",
                        "money_at_risk": 500, "first_detected_at": "2026-10-07T09:15:00+00:00", "action_taken": null, "owner": "Aditya" }],
  "tech_jobs": [{ "id": "91fd…", "type": "fix", "title": "Calendar not syncing", "status": "todo", "owner": "Sameer",
                  "sla_minutes": 30, "genexa_minutes": 960, "paused_minutes": 0, "is_paused": false, "is_overdue": true, "met_sla": null }],
  "recent_touches": [{ "id": "c2d0…", "at": "2026-10-05T14:02:11+00:00", "kind": "call", "by": "Ryan", "note": "Weekly check-in" }] }
```

## get_ad_metrics

`client_id` (required), `window` (required): `3d` | `7d` | `all`. `account` is for the window asked for; `spend_7d`, `booked_7d`, `cost_per_booked_7d` and `verdict` are always the last 7 days. `ads` are Cortana's own 7-day and all-time rows side by side, whatever the window. `account` is null for a client with no Cortana business.

```json
{ "name": "get_ad_metrics", "arguments": { "client_id": "7b0c…", "window": "7d" } }
```
```json
{ "window": "7d", "client_id": "7b0c…",
  "account": { "name": "Alpha Clinic", "stage": "live", "launch_date": "2026-08-28", "days_live": 40, "sop_stage": "Day 31+",
               "unverified": false, "window_from": "2026-09-30", "window_to": "2026-10-06",
               "spend": 980, "leads": 14, "booked": 9, "shows": 4, "closes": 1, "revenue": 6000,
               "cpl": 70, "cost_per_booked": 108.89, "booking_rate": 0.64, "frequency": 1.6, "ctr": 1.4, "cpm": 31.2,
               "spend_7d": 980, "booked_7d": 9, "cost_per_booked_7d": 108.89, "verdict": "amber" },
  "ads": [{ "ad_id": "ad1", "ad_name": "Knee pain video", "ad_status": "ACTIVE", "is_active": true,
            "spend_7d": 140, "leads_7d": 6, "booked_7d": 2, "cost_per_booked_7d": 70, "frequency_7d": 1.4, "ctr_7d": 1.5,
            "spend_all": 900, "leads_all": 40, "booked_all": 12, "cost_per_booked_all": 75, "frequency_all": 2.1, "ctr_all": 1.67,
            "fatigue": false, "fatigue_reason": null }],
  "ad_level_windows": ["7d", "all"] }
```

## get_exceptions

`status` (optional): `open` (default) | `snoozed` | `resolved`. Biggest $ at risk first, at most 500 rows.

```json
{ "name": "get_exceptions", "arguments": {} }
```
```json
{ "status": "open", "count": 1, "money_at_risk": 500,
  "exceptions": [{ "id": "e41a…", "type": "zero_spend", "severity": "red", "status": "open", "reason": "$0 ad spend 24h+",
                   "money_at_risk": 500, "client_id": "7b0c…", "client": "Alpha Clinic", "owner": "Aditya",
                   "first_detected_at": "2026-10-07T09:15:00+00:00", "action_taken": null, "resolved_at": null }] }
```

## get_tech_jobs

`status` (optional): `todo` | `working` | `stuck` | `done`. Left out = everything not done. SLA minutes are Genexa time (elapsed minus paused; fixes in business minutes). At most 300 rows.

```json
{ "name": "get_tech_jobs", "arguments": { "status": "todo" } }
```
```json
{ "status": "todo",
  "jobs": [{ "id": "91fd…", "type": "fix", "title": "Calendar not syncing", "status": "todo", "client": "Alpha Clinic", "owner": "Sameer",
             "requested_at": "2026-10-04T15:00:00+00:00", "due_at": "2026-10-05T13:30:00+00:00", "done_at": null, "blocked_on": null,
             "sla_minutes": 30, "genexa_minutes": 960, "paused_minutes": 0, "pause_count": 0,
             "is_paused": false, "is_overdue": true, "met_sla": null }] }
```

## get_launches

No arguments. The launch board (`launch_board`): live launches drop off after 14 days.

```json
{ "name": "get_launches", "arguments": {} }
```
```json
{ "launches": [{ "launch_id": "5a11…", "client_id": "c9e2…", "client_name": "Beta Clinic", "owner_name": "Sameer",
                 "stage": "paid", "stage_order": 1, "paid_at": "2026-10-04T15:00:00+00:00", "live_at": null,
                 "qc_done": 0, "qc_all": false, "days_waiting": 3, "waiting_colour": "green",
                 "clock_started": false, "sla_hours_elapsed": null, "sla_hours_allowed": 48,
                 "is_paused": false, "is_overdue": false, "met_sla": null }] }
```

## get_call_centre

`window` (optional, ignored). There is no call data source yet.

```json
{ "name": "get_call_centre", "arguments": { "window": "7d" } }
```
```json
{ "status": "not_available", "reason": "Call centre moves to Hot Prospector — not set up yet." }
```

## get_scores

`week` (optional): the Monday the week starts on, `YYYY-MM-DD`. Default: the current week.

```json
{ "name": "get_scores", "arguments": { "week": "2026-10-05" } }
```
```json
{ "week_start": "2026-10-05",
  "scores": [{ "staff_id": "0d3e…", "name": "Sameer", "role": "tech", "card": "tech", "metric": "fix_sla_pct",
               "value": 80, "numerator": 4, "denominator": 5, "colour": "amber", "is_baseline": false }] }
```

## get_eods

`from`, `to` (required, `YYYY-MM-DD`, inclusive, at most 92 days).

```json
{ "name": "get_eods", "arguments": { "from": "2026-10-05", "to": "2026-10-07" } }
```
```json
{ "from": "2026-10-05", "to": "2026-10-07",
  "eods": [{ "staff_id": "44a0…", "name": "Amanda Harder", "date": "2026-10-07", "role": "csr",
             "answers": { "dials": 40 }, "submitted_at": "2026-10-07T21:04:00+00:00" }] }
```

## get_tasks

`owner` (optional): staff name (full or first name) or id. Open tasks only. With no owner, only people with something open are listed.

```json
{ "name": "get_tasks", "arguments": { "owner": "Sameer" } }
```
```json
{ "owners": [{ "owner_id": "0d3e…", "owner": "Sameer", "role": "tech", "open_tasks": 1, "overdue_tasks": 1,
               "tasks": [{ "id": "b77c…", "title": "Fix the calendar", "category": "tech", "priority": "medium", "status": "todo",
                           "group": "week", "due": "2026-10-05", "days_overdue": 2, "client": null, "source": "ryan", "notes": null }] }] }
```

## get_prospects

No arguments. Never includes contact details.

```json
{ "name": "get_prospects", "arguments": {} }
```
```json
{ "prospects": [{ "id": "f3b9…", "name": "Smith Regen", "heat": "hot", "state": "FL", "stage": "chase", "call_date": "2026-10-01",
                  "what_they_want": "20 consults a month", "objection": "Price", "promised": "Case studies",
                  "follow_up_date": "2026-10-04", "follow_up_days_overdue": 3, "fathom_url": null, "deal_size": 9000 }] }
```

## get_agency_month

`month` (required): `YYYY-MM`. A closed month returns its frozen snapshot. Otherwise the live figures for the month so far; `mrr` is today's (from `client_fees`), not the month-end figure.

```json
{ "name": "get_agency_month", "arguments": { "month": "2026-10" } }
```
```json
{ "month": "2026-10", "frozen": false, "from": "2026-10-01", "to": "2026-10-07",
  "figures": { "ad_spend": 150, "leads": 2, "booked": 1, "confirmed": 0, "shows": 0, "no_shows": 0, "closes": 0,
               "clinic_revenue": 0, "cash_collected": 3500, "expenses": null, "bank_revenue": null },
  "mrr": 5500, "mrr_as_of": "2026-10-07", "whop_recurring_mrr": 3500 }
```
Frozen: `{ "month": "2026-08", "frozen": true, "frozen_at": "2026-09-01T04:05:00+00:00", "snapshot": { … } }`

## get_sync_status

No arguments. `freshness`: `fresh` | `late` | `stale` | `never`.

```json
{ "name": "get_sync_status", "arguments": {} }
```
```json
{ "sources": [{ "source": "cortana", "schedule_minutes": 15, "last_attempt_at": "2026-10-07T15:00:02+00:00",
                "last_success_at": "2026-10-07T15:00:02+00:00", "rows_processed": 412, "error": null,
                "minutes_since_success": 3.1, "freshness": "fresh", "is_stale": false }] }
```

---

# Write tools

All audited as `claude`. Nothing can be deleted.

## write_brief

`date`, `kind` (`daily` | `weekly`), `markdown` (all required). One brief per date and kind: writing again replaces it.

```json
{ "name": "write_brief", "arguments": { "date": "2026-10-07", "kind": "daily", "markdown": "# Wednesday\n- Alpha at $0 spend…" } }
```
```json
{ "id": "a1c4…", "date": "2026-10-07", "kind": "daily", "written_by": "claude", "created": true, "characters": 38 }
```

## add_task

`owner` (name or id), `title`, `category` (`ads` | `call_centre` | `tech` | `general`), `source` (`pushpin` | `claude` | `call` | `slack` | `system`) required; `client_id`, `due`, `notes` optional. Subject to the three task rules above.

```json
{ "name": "add_task", "arguments": { "owner": "Sameer", "title": "Reconnect the Alpha pixel", "category": "tech",
                                     "source": "claude", "client_id": "7b0c…", "due": "2026-10-10" } }
```
```json
{ "id": "d09e…", "owner_id": "0d3e…", "owner": "Sameer", "title": "Reconnect the Alpha pixel", "category": "tech",
  "priority": "medium", "status": "todo", "group": "week", "source": "claude", "client_id": "7b0c…", "due": "2026-10-10", "notes": null }
```
Refused (`isError: true`):
```json
{ "error": { "code": "TASK_DELETED_MATCH", "message": "Aditya deleted a task like this: \"Refresh creatives for Multivita IV\".",
             "rule": "A title that matches a task the owner deleted is not added again.", "enforced_by": "endpoint",
             "matched": { "title": "Refresh creatives for Multivita IV", "similarity": 0.83 } } }
```

## add_idea

`text`, `source` (both required; source is free text such as `claude`, `call`, `slack`).

```json
{ "name": "add_idea", "arguments": { "text": "Offer a show-rate guarantee", "source": "claude" } }
```
```json
{ "id": "6e2f…", "text": "Offer a show-rate guarantee", "source": "claude", "created_at": "2026-10-07T15:12:40+00:00" }
```

## upsert_prospect

`name` (required) finds an existing prospect, case-insensitive; otherwise a new one is created in stage `chase`. Optional: `heat` (`hot` | `warm` | `cold`), `state`, `call_date`, `what_they_want`, `objection`, `promised`, `follow_up_date`, `fathom_url`, `deal_size`, `stage` (`chase` | `contract_out` | `paid` | `dead`). Only the fields given are changed. `contact` is not accepted and is never touched.

```json
{ "name": "upsert_prospect", "arguments": { "name": "smith regen", "heat": "warm", "objection": "Price", "follow_up_date": "2026-10-12" } }
```
```json
{ "created": false,
  "prospect": { "id": "f3b9…", "name": "Smith Regen", "heat": "warm", "state": "FL", "stage": "chase", "call_date": "2026-10-01",
                "what_they_want": "20 consults a month", "objection": "Price", "promised": "Case studies",
                "follow_up_date": "2026-10-12", "fathom_url": null, "deal_size": 9000 } }
```

## set_next_action

`client_id`, `text` (both required).

```json
{ "name": "set_next_action", "arguments": { "client_id": "7b0c…", "text": "Renewal call Friday" } }
```
```json
{ "client_id": "7b0c…", "client": "Alpha Clinic", "next_action": "Renewal call Friday" }
```

## log_touch

`client_id`, `kind` (`call` | `loom` | `report` | `slack` | `email`), `note` (all required). Logged at the current time; also moves the client's last-contact date forward.

```json
{ "name": "log_touch", "arguments": { "client_id": "7b0c…", "kind": "email", "note": "Sent the weekly report" } }
```
```json
{ "id": "c88b…", "client_id": "7b0c…", "kind": "email", "at": "2026-10-07T15:14:02+00:00",
  "note": "Sent the weekly report", "last_contact_us": "2026-10-07T15:14:02+00:00" }
```

## set_exception_action

`id`, `text` (both required). Sets the exception's `action_taken`. Does not resolve or snooze it.

```json
{ "name": "set_exception_action", "arguments": { "id": "e41a…", "text": "Card updated, ads back on" } }
```
```json
{ "id": "e41a…", "type": "zero_spend", "status": "open", "action_taken": "Card updated, ads back on" }
```
