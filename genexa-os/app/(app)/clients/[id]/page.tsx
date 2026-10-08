import Link from "next/link";
import { notFound } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { addLocation, addTouch, removeLocation, updateClient, updateLocation } from "@/lib/actions/clients";
import { requireStaff } from "@/lib/auth/staff";
import { formatValue, type Unit } from "@/lib/format";
import { PODS, STAGES, getClientProfile, type ClientMtd } from "@/lib/queries/clients";

const NO_DATA = <span className="text-stale">no data</span>;
const ERRORS: Record<string, string> = {
  owner_only: "Not saved: only the owner can change client details and locations.",
  invalid: "Not saved: check the fee and target are numbers and the dates are valid.",
  save: "Not saved: the database refused the change.",
  touch: "Touch not logged: pick what kind of contact it was.",
  touch_save: "Touch not logged: the database refused it.",
  location: "Location not saved: it needs a name, and the calendar link must be a full URL (https://...).",
};
const SAVED: Record<string, string> = {
  client: "Client details saved.", touch: "Touch logged.", location: "Location saved.", location_removed: "Location removed.",
};
const TOUCH_KINDS = ["call", "loom", "report", "slack", "email"];
const MTD: { key: keyof ClientMtd; label: string; unit: Unit | "ratio" }[] = [
  { key: "spend", label: "Spend", unit: "money" }, { key: "leads", label: "Leads", unit: "count" },
  { key: "booked", label: "Booked", unit: "count" }, { key: "confirmed", label: "Confirmed", unit: "count" },
  { key: "shows", label: "Shows", unit: "count" }, { key: "closes", label: "Closes", unit: "count" },
  { key: "revenue", label: "Revenue", unit: "money" }, { key: "cpl", label: "CPL", unit: "money" },
  { key: "cost_per_booked", label: "Cost / booked", unit: "money" }, { key: "booking_rate", label: "Booking rate", unit: "percent" },
  { key: "confirmation_rate", label: "Confirm rate", unit: "percent" }, { key: "show_rate", label: "Show rate", unit: "percent" },
  { key: "close_rate", label: "Close rate", unit: "percent" }, { key: "ctr", label: "CTR", unit: "percent" },
  { key: "roas", label: "ROAS", unit: "ratio" },
];
const show = (value: number | null, unit: Unit | "ratio") =>
  unit === "ratio" ? (value === null ? null : `${value.toFixed(2)}x`) : formatValue(value, unit);

const input = "rounded border border-line bg-raised px-2 py-1 text-sm";
const label = "flex flex-col gap-1 text-xs text-muted";
const button = "cursor-pointer rounded bg-accent px-3 py-1.5 text-xs font-medium text-white";

export default async function ClientPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const me = await requireStaff();
  const { id } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const profile = await getClientProfile(id);
  if (!profile) notFound();
  const { client: c, health, renewal, scope, ads_state, mtd } = profile;
  const isOwner = me.role === "owner";
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;
  const saved = typeof query.saved === "string" ? SAVED[query.saved] : undefined;

  const facts: [string, string | null][] = [
    ["Stage", c.stage], ["Pod", c.pod?.replace("pod_", "Pod ") ?? null], ["Contact", c.contact_name],
    ["Billing cycle", c.billing_cycle ? (c.billing_cycle === "legacy" ? "Legacy (30 days)" : `${c.billing_cycle} days`) : null],
    ["Fee per cycle", formatValue(c.cycle_fee, "money")],
    ["Monthly fee", formatValue(c.monthly_fee, "money")],
    ["Launch date", c.launch_date],
    ["Next renewal", renewal?.renewal_date ? `${renewal.renewal_date} · ${renewal.status}` : (renewal?.status ?? null)],
    ["Guarantee", c.guarantee_text
      ? `${c.guarantee_text}${c.guarantee_target_amount !== null ? ` · target ${formatValue(c.guarantee_target_amount, "money")}` : ""}${c.guarantee_deadline ? ` · due ${c.guarantee_deadline}` : ""}`
      : null],
    ["Cortana", c.cortana_business_id ? (scope && !scope.verified ? "Connected · scope unverified" : scope?.campaign_name_contains ? `Connected · campaigns containing "${scope.campaign_name_contains}"` : "Connected") : "Not connected"],
    ["Next action", c.next_action],
    ["Last contact (us)", c.last_contact_us], ["Last reply (client)", c.last_reply_client],
  ];
  const tone = c.stage !== "live" ? "bg-stale-bg text-stale" : health?.colour === "red" ? "bg-bad-bg text-bad" : health?.colour === "amber" ? "bg-warn-bg text-warn" : "bg-good-bg text-good";

  return (
    <div className="flex flex-col gap-5 p-4">
      <Link href="/clients" className="text-xs text-muted underline">← Clients</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{c.name}</h1>
        <span className={`rounded-full px-2.5 py-1 text-xs ${tone}`}>{c.stage !== "live" ? c.stage : (health?.reasons ?? "No issues found")}</span>
      </div>
      {scope?.note ? <p className="text-xs text-muted">{scope.note}</p> : null}
      {error ? <p className="rounded bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p> : null}
      {saved ? <p className="rounded bg-good-bg px-3 py-2 text-sm text-good">{saved}</p> : null}

      <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-line bg-panel p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd>{v ?? NO_DATA}</dd>
          </div>
        ))}
      </dl>

      {isOwner ? (
        <details className="rounded-lg border border-line bg-panel">
          <summary className="cursor-pointer px-4 py-2 text-sm font-semibold">Edit client details</summary>
          <form action={updateClient} className="grid gap-3 border-t border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="id" value={c.id} />
            <label className={label}>Stage
              <select name="stage" defaultValue={c.stage} className={input}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </label>
            <label className={label}>Pod
              <select name="pod" defaultValue={c.pod ?? ""} className={input}>
                <option value="">No pod</option>
                {PODS.map((p) => <option key={p} value={p}>{p.replace("pod_", "Pod ")}</option>)}
              </select>
            </label>
            <label className={label}>Contact name<input name="contact_name" defaultValue={c.contact_name ?? ""} className={input} /></label>
            <label className={label}>Cortana business id<input name="cortana_business_id" defaultValue={c.cortana_business_id ?? ""} className={input} /></label>
            <label className={label}>Billing cycle
              <select name="billing_cycle" defaultValue={c.billing_cycle ?? ""} className={input}>
                <option value="">Not set</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="legacy">Legacy (30 days)</option>
              </select>
            </label>
            <label className={label}>Fee per cycle ($)<input name="cycle_fee" type="number" min="0" step="0.01" defaultValue={c.cycle_fee ?? ""} className={input} /></label>
            <label className={label}>Launch date<input name="launch_date" type="date" defaultValue={c.launch_date ?? ""} className={input} /></label>
            <label className={label}>Last contact (us)<input name="last_contact_us" type="date" defaultValue={c.last_contact_us ?? ""} className={input} /></label>
            <label className={label}>Last reply (client)<input name="last_reply_client" type="date" defaultValue={c.last_reply_client ?? ""} className={input} /></label>
            <label className={label}>Guarantee target ($)<input name="guarantee_target_amount" type="number" min="0" step="0.01" defaultValue={c.guarantee_target_amount ?? ""} className={input} /></label>
            <label className={label}>Guarantee deadline<input name="guarantee_deadline" type="date" defaultValue={c.guarantee_deadline ?? ""} className={input} /></label>
            <label className={`${label} sm:col-span-2 lg:col-span-4`}>Guarantee<textarea name="guarantee_text" rows={2} defaultValue={c.guarantee_text ?? ""} className={input} /></label>
            <label className={`${label} sm:col-span-2 lg:col-span-4`}>Next action<textarea name="next_action" rows={2} defaultValue={c.next_action ?? ""} className={input} /></label>
            <div className="sm:col-span-2 lg:col-span-4">
              <button type="submit" className={button}>Save client details</button>
              <span className="ml-3 text-xs text-muted">Monthly fee is worked out from the fee per cycle. Dates are ET.</span>
            </div>
          </form>
        </details>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold">This month (ET)</h2>
        {ads_state !== "ok" ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-stale">
            {ads_state === "not_connected" ? "Not connected: this clinic has no Cortana business, so there are no numbers to show." : "Unverified: this clinic's Cortana campaign scope has not been checked by a person, so its numbers are held back."}
          </p>
        ) : mtd === null ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-stale">No data recorded this month.</p>
        ) : (
          <dl className="grid grid-cols-3 gap-x-6 gap-y-2 rounded-lg border border-line bg-panel p-4 text-sm sm:grid-cols-5">
            {MTD.map((m) => (
              <div key={m.key}>
                <dt className="text-xs text-muted">{m.label}</dt>
                <dd className="tabular-nums">{show(mtd[m.key], m.unit) ?? NO_DATA}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Touches</h2>
        <form action={addTouch} className="mb-2 flex flex-wrap items-end gap-2 rounded border border-line bg-panel p-3">
          <input type="hidden" name="client_id" value={c.id} />
          <label className={label}>Kind
            <select name="kind" defaultValue="call" className={input}>{TOUCH_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          </label>
          <label className={`${label} min-w-64 flex-1`}>Note<input name="note" placeholder="What was said or sent" className={input} /></label>
          <button type="submit" className={button}>Add touch</button>
        </form>
        <DataTable
          columns={["Date (ET)", "Kind", "By", "Note"]}
          rows={profile.touches.map((t) => [t.on, t.kind, t.by, t.note])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Locations</h2>
        {profile.locations.length === 0 ? (
          <p className="rounded border border-line bg-panel px-4 py-6 text-sm text-muted">No locations on the clinic sheet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {profile.locations.map((l) => (
              <div key={l.id} className="rounded border border-line bg-panel p-3 text-sm">
                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
                  <div><div className="text-xs text-muted">Name</div>{l.name}</div>
                  <div><div className="text-xs text-muted">Address</div>{l.address ?? NO_DATA}</div>
                  <div><div className="text-xs text-muted">Doctors</div>{l.doctors.length ? l.doctors.join(", ") : NO_DATA}</div>
                  <div><div className="text-xs text-muted">Price points</div>{l.price_points ?? NO_DATA}</div>
                  <div className="truncate"><div className="text-xs text-muted">Calendar</div>
                    {l.calendar_url ? <a href={l.calendar_url} target="_blank" rel="noreferrer" className="underline">{l.calendar_url}</a> : NO_DATA}
                  </div>
                </div>
                {isOwner ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted">Edit or remove</summary>
                    <form action={updateLocation} className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                      <input type="hidden" name="client_id" value={c.id} />
                      <input type="hidden" name="location_id" value={l.id} />
                      <label className={label}>Name<input name="name" required defaultValue={l.name} className={input} /></label>
                      <label className={label}>Address<input name="address" defaultValue={l.address ?? ""} className={input} /></label>
                      <label className={label}>Doctors (comma separated)<input name="doctors" defaultValue={l.doctors.join(", ")} className={input} /></label>
                      <label className={label}>Price points<input name="price_points" defaultValue={l.price_points ?? ""} className={input} /></label>
                      <label className={label}>Calendar URL<input name="calendar_url" type="url" defaultValue={l.calendar_url ?? ""} className={input} /></label>
                      <div><button type="submit" className={button}>Save location</button></div>
                    </form>
                    <form action={removeLocation} className="mt-2">
                      <input type="hidden" name="client_id" value={c.id} />
                      <input type="hidden" name="location_id" value={l.id} />
                      <button type="submit" className="cursor-pointer rounded border border-line px-3 py-1.5 text-xs text-bad">Remove location</button>
                    </form>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {isOwner ? (
          <details className="mt-2 rounded border border-line bg-panel">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">Add a location</summary>
            <form action={addLocation} className="grid gap-2 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-5">
              <input type="hidden" name="client_id" value={c.id} />
              <label className={label}>Name<input name="name" required className={input} /></label>
              <label className={label}>Address<input name="address" className={input} /></label>
              <label className={label}>Doctors (comma separated)<input name="doctors" className={input} /></label>
              <label className={label}>Price points<input name="price_points" className={input} /></label>
              <label className={label}>Calendar URL<input name="calendar_url" type="url" className={input} /></label>
              <div><button type="submit" className={button}>Add location</button></div>
            </form>
          </details>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Payments (Whop)</h2>
        <DataTable
          columns={["Date (ET)", "Product", "Amount", "Status"]}
          rows={profile.payments.map((p) => [p.paid_on, p.product, formatValue(p.amount, "money"), p.status === "open" ? "charge failed" : p.status])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Whop memberships</h2>
        <DataTable
          columns={["Product", "Status", "Renews (ET)", "Price", "Period"]}
          rows={profile.memberships.map((m) => [
            m.product,
            m.status === null ? null : `${m.status}${m.cancelling ? " · cancels at period end" : ""}${m.valid ? "" : " · not valid"}`,
            m.renews_on,
            formatValue(m.price, "money"),
            m.period_days === null ? "one-off" : `${m.period_days} days`,
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Tech jobs</h2>
        <DataTable
          columns={["Job", "Type", "Status", "Requested (ET)", "Due (ET)", "Done (ET)", "SLA"]}
          rows={profile.tech_jobs.map((j) => [j.title, j.type, j.status, j.requested_on, j.due_on ?? "—", j.done_on ?? "—", j.overdue === null ? null : j.overdue ? "overdue" : "on time"])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Exceptions</h2>
        <DataTable
          columns={["Status", "Severity", "What", "First seen", "At risk", "Resolved"]}
          rows={profile.exceptions.map((e) => [e.status, e.severity, e.reason, e.first_seen, (e.money_at_risk ?? 0) > 0 ? formatValue(e.money_at_risk, "money") : "—", e.resolved ?? "—"])}
        />
      </section>
    </div>
  );
}
