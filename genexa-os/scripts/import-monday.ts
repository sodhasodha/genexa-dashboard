/**
 * One-off import from monday.com into Genexa OS.
 *
 *   npm run import:monday             insert anything not yet imported
 *   npm run import:monday -- --refresh   also overwrite imported rows with Monday's current values
 *
 * Read-only against Monday: it only ever sends `query` operations.
 * Re-runnable: every row carries its Monday item id in legacy_ref, so a second
 * run never duplicates. Without --refresh, rows already imported are left alone
 * so edits made in the app are not overwritten.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  isVitaleSplitItem, mapClient, mapDeletedItems, mapProspect, mapStaff, mapTask, mapTechJob, matchClient,
  matchCortanaBusiness, type MondayActivity, type MondayBoard, type Unmapped,
} from "../lib/integrations/monday/mapper";

const BOARDS = {
  clients: "5094961079",
  team: "5104556071",
  ryan: "5104549188",
  aditya: "5104549185",
  sameer: "5104549190",
  prospects: "5104549184",
} as const;

// Logins supplied by Ryan, keyed by the first word of the staff member's name.
const EMAILS: Record<string, string> = {
  ryan: "ryan@genexascaling.com",
  aditya: "adityaarajdhiman@gmail.com",
  sameer: "sameerhashim647@gmail.com",
  amanda: "edelweiss.harder@gmail.com",
  phenelopy: "phenelopydepositar@gmail.com",
  marjorie: "marjoriegrace.villarino@gmail.com",
  almarie: "llamesalmarie@gmail.com",
};
// People who are not on the Team board.
const EXTRA_STAFF = [
  { legacy_ref: "manual:ryan", name: "Ryan", role: "owner", also_role: null, pod: null, status: "active", start_date: null },
  { legacy_ref: "manual:sameer", name: "Sameer", role: "tech", also_role: null, pod: null, status: "active", start_date: null },
];

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
};
const refresh = process.argv.includes("--refresh");
const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const unmapped: Unmapped[] = [];
const RAW_DIR = join(__dirname, "../fixtures/monday/raw");

async function monday<T>(query: string): Promise<T> {
  if (!/^\s*query\b/.test(query)) throw new Error("Monday import is read-only: only query operations are allowed");
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: env("MONDAY_API_TOKEN"), "API-Version": "2024-10", "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length || !json.data) {
    throw new Error(`Monday ${res.status}: ${json.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  }
  return json.data;
}

async function fetchBoard(id: string): Promise<MondayBoard> {
  const data = await monday<{ boards: MondayBoard[] }>(
    `query { boards(ids: ${id}) { id name columns { id title type } items_page(limit: 500) { cursor items { id name created_at updated_at group { id title } column_values { id text value type } } } } }`,
  );
  const board = data.boards[0];
  if (!board) throw new Error(`Monday board ${id} not found`);
  if (board.items_page.cursor) throw new Error(`Board ${board.name} has more than 500 items; paging is needed`);
  writeFileSync(join(RAW_DIR, `board_${id}.json`), JSON.stringify({ data }, null, 1));
  return board;
}

async function fetchDeletedLog(boardId: string, days: number): Promise<MondayActivity[]> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const all: MondayActivity[] = [];
  for (let page = 1; ; page++) {
    const data = await monday<{ boards: { activity_logs: MondayActivity[] }[] }>(
      `query { boards(ids: ${boardId}) { activity_logs(from: "${from}", to: "${to}", limit: 1000, page: ${page}) { id event created_at data } } }`,
    );
    const logs = data.boards[0]?.activity_logs ?? [];
    all.push(...logs);
    if (logs.length < 1000) break;
  }
  writeFileSync(join(RAW_DIR, `activity_${boardId}.json`), JSON.stringify(all, null, 1));
  return all;
}

async function fetchCortanaBusinesses(): Promise<{ id: string; name: string }[]> {
  const base = process.env.CORTANA_BASE_URL ?? "https://app.usecortana.ai/api/v1";
  const res = await fetch(`${base}/businesses`, { headers: { Authorization: `Bearer ${env("CORTANA_API_KEY")}` } });
  if (!res.ok) throw new Error(`Cortana ${res.status}`);
  return ((await res.json()) as { data: { id: string; name: string }[] }).data;
}

type Row = Record<string, unknown> & { legacy_ref: string };

/** Insert rows whose legacy_ref is new; with --refresh, update the rest. Returns ref -> id. */
async function upsertByRef(table: string, rows: Row[]): Promise<{ ids: Map<string, string>; inserted: number; updated: number }> {
  const ids = new Map<string, string>();
  let inserted = 0;
  let updated = 0;
  if (rows.length === 0) return { ids, inserted, updated };
  const { data: existing, error } = await db.from(table).select("id, legacy_ref").in("legacy_ref", rows.map((r) => r.legacy_ref));
  if (error) throw new Error(`${table}: ${error.message}`);
  for (const e of existing ?? []) ids.set(e.legacy_ref as string, e.id as string);
  for (const row of rows) {
    const id = ids.get(row.legacy_ref);
    if (!id) {
      const { data, error: insertError } = await db.from(table).insert(row).select("id").single();
      if (insertError) {
        unmapped.push({ board: table, item: String(row.title ?? row.name ?? row.legacy_ref), problem: `not imported: ${insertError.message}` });
        continue;
      }
      ids.set(row.legacy_ref, data.id as string);
      inserted++;
    } else if (refresh) {
      const { error: updateError } = await db.from(table).update(row).eq("id", id);
      if (updateError) {
        unmapped.push({ board: table, item: String(row.title ?? row.name ?? row.legacy_ref), problem: `not refreshed: ${updateError.message}` });
        continue;
      }
      updated++;
    }
  }
  return { ids, inserted, updated };
}

async function ensureAuthUser(email: string): Promise<string> {
  const created = await db.auth.admin.createUser({ email, email_confirm: true });
  if (created.data.user) return created.data.user.id;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`auth: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  throw new Error(`auth: could not create or find ${email}: ${created.error?.message}`);
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  console.log(`Monday import (${refresh ? "refresh: overwrite imported rows" : "insert-only for new rows"})\n`);
  const [clientsBoard, teamBoard, ryanBoard, adityaBoard, sameerBoard, prospectsBoard, deletedLog, businesses] = await Promise.all([
    fetchBoard(BOARDS.clients), fetchBoard(BOARDS.team), fetchBoard(BOARDS.ryan), fetchBoard(BOARDS.aditya),
    fetchBoard(BOARDS.sameer), fetchBoard(BOARDS.prospects), fetchDeletedLog(BOARDS.aditya, 60), fetchCortanaBusinesses(),
  ]);
  const summary: string[] = [];
  const note = (label: string, r: { inserted: number; updated: number }, seen: number) =>
    summary.push(`${label.padEnd(22)} ${String(seen).padStart(3)} read · ${r.inserted} inserted · ${r.updated} refreshed`);

  // --- staff + staff_pay + logins -----------------------------------------
  const team = teamBoard.items_page.items.map((i) => mapStaff(teamBoard, i, unmapped)).filter((x) => x !== null);
  const staffRows = [...team.map((t) => t.staff), ...EXTRA_STAFF].map((s) => ({
    ...s,
    email: EMAILS[s.name.split(/\s+/)[0].toLowerCase()] ?? null,
  }));
  const staff = await upsertByRef("staff", staffRows);
  note("staff", staff, staffRows.length);
  let payWritten = 0;
  for (const t of team) {
    const staffId = staff.ids.get(t.staff.legacy_ref);
    if (!staffId) continue;
    const { data: existing } = await db.from("staff_pay").select("id").eq("staff_id", staffId).maybeSingle();
    if (!existing) {
      const { error } = await db.from("staff_pay").insert({ staff_id: staffId, ...t.pay });
      if (error) throw new Error(`staff_pay: ${error.message}`);
      payWritten++;
    } else if (refresh) {
      const { error } = await db.from("staff_pay").update(t.pay).eq("id", existing.id);
      if (error) throw new Error(`staff_pay: ${error.message}`);
      payWritten++;
    }
  }
  summary.push(`${"staff_pay".padEnd(22)} ${String(team.length).padStart(3)} read · ${payWritten} written`);
  let logins = 0;
  for (const s of staffRows) {
    const staffId = staff.ids.get(s.legacy_ref);
    if (!staffId) continue;
    if (!s.email) {
      unmapped.push({ board: "Team", item: s.name, problem: "no email supplied: imported without a login" });
      continue;
    }
    const authUserId = await ensureAuthUser(s.email);
    const { error } = await db.from("staff").update({ auth_user_id: authUserId, email: s.email }).eq("id", staffId).is("auth_user_id", null);
    if (error) throw new Error(`staff login: ${error.message}`);
    logins++;
  }
  summary.push(`${"logins (auth users)".padEnd(22)} ${String(logins).padStart(3)} linked`);
  const staffId = (ref: string) => {
    const id = staff.ids.get(ref);
    if (!id) throw new Error(`staff ${ref} missing`);
    return id;
  };
  const ryanId = staffId("manual:ryan");
  const sameerId = staffId("manual:sameer");
  const adityaRef = team.find((t) => t.staff.name.toLowerCase() === "aditya")?.staff.legacy_ref;
  if (!adityaRef) throw new Error("Aditya is not on the Team board");
  const adityaId = staffId(adityaRef);

  // --- clients ---------------------------------------------------------------
  const clientRows = clientsBoard.items_page.items.map((i) => mapClient(clientsBoard, i, unmapped));
  const clients = await upsertByRef("clients", clientRows);
  note("clients", clients, clientRows.length);

  // Cortana business ids: only clear name matches are written, and never over an existing value.
  const cortanaLines: string[] = [];
  for (const row of clientRows) {
    const id = clients.ids.get(row.legacy_ref);
    if (!id) continue;
    const { match, candidates } = matchCortanaBusiness(row.name, businesses);
    if (match) {
      const { error } = await db.from("clients").update({ cortana_business_id: match.business_id }).eq("id", id).is("cortana_business_id", null);
      if (error) throw new Error(`clients cortana id: ${error.message}`);
      cortanaLines.push(`  ${row.name.padEnd(42)} -> ${match.business_name}  [${match.confidence}]`);
    } else {
      const hint = candidates.length ? `possible: ${candidates.map((c) => c.business_name).join(" / ")}` : "no Cortana business with a similar name";
      cortanaLines.push(`  ${row.name.padEnd(42)} -> (blank)  ${hint}`);
    }
  }
  const usedBusinessNames = new Set(clientRows.map((r) => matchCortanaBusiness(r.name, businesses).match?.business_name));
  const unusedBusinesses = businesses.filter((b) => !usedBusinessNames.has(b.name)).map((b) => b.name);

  // Campaign scope: the two clinics whose Cortana business is known to cover more than our campaigns.
  const scopes = [
    { match: "Regen RX", campaign_name_contains: "Genexa", verified: true, note: "Cortana reads the clinic's whole ad account; only campaigns named \"Genexa\" are ours." },
    { match: "cleveland icp", campaign_name_contains: null, verified: false, note: "Unverified: Cleveland and Georgia return identical Meta spend in Cortana. Do not trust ad numbers until separated." },
  ];
  let scopesWritten = 0;
  for (const s of scopes) {
    const row = clientRows.find((c) => c.name.toLowerCase() === s.match.toLowerCase());
    const clientId = row ? clients.ids.get(row.legacy_ref) : undefined;
    if (!clientId) {
      unmapped.push({ board: "client_campaign_scope", item: s.match, problem: "client not found" });
      continue;
    }
    const { data: existing } = await db.from("client_campaign_scope").select("id").eq("client_id", clientId).maybeSingle();
    if (!existing) {
      const { error } = await db.from("client_campaign_scope").insert({ client_id: clientId, campaign_name_contains: s.campaign_name_contains, verified: s.verified, note: s.note });
      if (error) throw new Error(`client_campaign_scope: ${error.message}`);
      scopesWritten++;
    }
  }
  summary.push(`${"client_campaign_scope".padEnd(22)} ${String(scopes.length).padStart(3)} read · ${scopesWritten} inserted`);

  const clientLookup = clientRows.map((c) => ({ name: c.name, contact_name: c.contact_name, id: clients.ids.get(c.legacy_ref) }));
  const resolveClient = (board: string, item: string, text: string | null) => {
    if (!text) return { client_id: null as string | null, extra: null as string | null };
    const hit = matchClient(text, clientLookup);
    if (hit?.id) return { client_id: hit.id, extra: null };
    if (!/,/.test(text)) unmapped.push({ board, item, problem: `client "${text}" did not match one clinic; kept in notes` });
    return { client_id: null, extra: `Clients: ${text}` };
  };

  // --- tasks -----------------------------------------------------------------
  const taskRows: Row[] = [];
  const splitJobs: Row[] = [];
  for (const item of ryanBoard.items_page.items) {
    const t = mapTask(ryanBoard, item, "ryan", unmapped);
    if (!t) continue;
    const { client_text: _unused, ...row } = t;
    void _unused;
    taskRows.push({ ...row, owner_id: ryanId });
  }
  for (const item of adityaBoard.items_page.items) {
    const t = mapTask(adityaBoard, item, "aditya", unmapped);
    if (!t) continue;
    const { client_text, ...row } = t;
    if (isVitaleSplitItem(item.name)) {
      const vitale = matchClient("Vitale", clientLookup);
      // Aditya keeps the ad price and the script; the launch and the GHL location are tech work.
      taskRows.push({
        ...row, legacy_ref: `${item.id}:ads`, owner_id: adityaId, category: "ads", client_id: vitale?.id ?? null,
        title: "Vitale new location: $2,999 ads + add location to script",
        notes: `Split from the Monday item "${item.name}". The launch and GHL location went to Sameer as a tech job.`,
      });
      splitJobs.push({
        legacy_ref: `${item.id}:tech`, owner_id: sameerId, requested_by: adityaId, client_id: vitale?.id ?? null, type: "launch",
        title: "Vitale new location: ad account launch + add GHL location", requested_at: item.created_at, status: "todo",
        notes: `Split from Aditya's Monday item "${item.name}".`,
      });
      continue;
    }
    const { client_id, extra } = resolveClient(adityaBoard.name, item.name, client_text);
    taskRows.push({ ...row, owner_id: adityaId, client_id, notes: [row.notes, extra].filter(Boolean).join("\n") || null });
  }
  const tasks = await upsertByRef("tasks", taskRows);
  note("tasks", tasks, taskRows.length);

  // --- tech jobs -------------------------------------------------------------
  const jobRows: Row[] = [...splitJobs];
  for (const item of sameerBoard.items_page.items) {
    const j = mapTechJob(sameerBoard, item, unmapped);
    if (!j) continue;
    const { client_text, ...row } = j;
    const { client_id, extra } = resolveClient(sameerBoard.name, item.name, client_text);
    if (!client_text) unmapped.push({ board: sameerBoard.name, item: item.name, problem: "no Clinic set on Monday: imported with no client" });
    jobRows.push({ ...row, owner_id: sameerId, client_id, notes: extra });
  }
  const jobs = await upsertByRef("tech_jobs", jobRows);
  note("tech_jobs", jobs, jobRows.length);

  // --- prospects ---------------------------------------------------------------
  const prospectRows = prospectsBoard.items_page.items.map((i) => mapProspect(prospectsBoard, i, unmapped)).filter((x) => x !== null);
  note("prospects", await upsertByRef("prospects", prospectRows), prospectRows.length);

  // --- deleted tasks (last, so the import's own inserts are never refused by them) ----
  const deletedRows = mapDeletedItems(deletedLog).map((d) => ({ ...d, owner_id: adityaId }));
  note("deleted_tasks", await upsertByRef("deleted_tasks", deletedRows), deletedRows.length);

  // --- report ----------------------------------------------------------------
  console.log("This run");
  for (const line of summary) console.log(`  ${line}`);
  console.log("\nRows now in the database");
  for (const table of ["staff", "staff_pay", "clients", "client_campaign_scope", "tasks", "tech_jobs", "prospects", "deleted_tasks", "audit_log"]) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error) throw new Error(`${table}: ${error.message}`);
    console.log(`  ${table.padEnd(22)} ${count}`);
  }
  console.log("\nCortana business matches (clinic -> Cortana business)");
  for (const line of cortanaLines) console.log(line);
  console.log(`\nCortana businesses not matched to any clinic: ${unusedBusinesses.join(", ") || "none"}`);
  console.log(`\nDid not map cleanly (${unmapped.length})`);
  for (const u of unmapped) console.log(`  [${u.board}] ${u.item}: ${u.problem}`);
}

main().catch((err) => {
  console.error(`\nImport failed: ${(err as Error).message}`);
  process.exit(1);
});
