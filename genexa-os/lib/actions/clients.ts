"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { etMidnight, etToday } from "@/lib/time";

// Every write goes through the logged-in user's Supabase client, so RLS and the
// audit trigger apply. Only the app owner may edit client fields and locations;
// RLS enforces it, and a refused write comes back as ?error=owner_only.

const Id = z.uuid();
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const blank = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : String(v).trim());
/** Noon ET on a date: a date-only entry stored as an instant that stays on that ET day. */
const noonEt = (date: string) => new Date(etMidnight(date).getTime() + 12 * 3_600_000).toISOString();

const back = (id: string, query: string): never => redirect(`/clients/${id}?${query}`);
const refreshed = (id: string) => {
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
};

const ClientEdit = z.object({
  stage: z.enum(["unlaunched", "onboarding", "live", "paused", "churned"]),
  pod: z.enum(["pod_1", "pod_2", "pod_3"]).nullable(),
  contact_name: z.string().max(200).nullable(),
  billing_cycle: z.enum(["30", "90", "legacy"]).nullable(),
  cycle_fee: z.coerce.number().min(0).max(10_000_000).nullable(),
  launch_date: DateStr.nullable(),
  guarantee_text: z.string().max(2000).nullable(),
  guarantee_target_amount: z.coerce.number().min(0).max(100_000_000).nullable(),
  guarantee_deadline: DateStr.nullable(),
  next_action: z.string().max(2000).nullable(),
  last_contact_us: DateStr.nullable(),
  last_reply_client: DateStr.nullable(),
  cortana_business_id: z.string().max(200).nullable(),
  rev_share_type: z.enum(["percent", "per_patient", "none"]),
  // Entered as a percentage (5 = 5%); blank = the standard rate.
  rev_share_percent: z.coerce.number().min(0).max(100).nullable(),
  rev_share_per_patient: z.coerce.number().min(0).max(1_000_000).nullable(),
});

/** Owner edits the client record. */
export async function updateClient(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("id"));
  if (me.role !== "owner") back(id, "error=owner_only");
  const parsed = ClientEdit.safeParse(Object.fromEntries(Object.keys(ClientEdit.shape).map((k) => [k, blank(formData.get(k))])));
  if (!parsed.success) back(id, "error=invalid");
  const { last_contact_us, last_reply_client, rev_share_percent, ...rest } = parsed.data!;
  if (rest.rev_share_type === "per_patient" && rest.rev_share_per_patient === null) back(id, "error=invalid");
  const fields = { ...rest, rev_share_rate: rev_share_percent === null ? null : rev_share_percent / 100 };

  const supabase = await createClient();
  const { data: current } = await supabase.from("clients").select("last_contact_us, last_reply_client").eq("id", id).maybeSingle();
  // The form holds these two as dates. A stored time is only replaced when the day itself was changed.
  const instant = (entered: string | null, stored: string | null) =>
    entered === null ? null : stored && etToday(new Date(stored)) === entered ? stored : noonEt(entered);
  const { data, error } = await supabase
    .from("clients")
    .update({
      ...fields,
      last_contact_us: instant(last_contact_us, current?.last_contact_us ?? null),
      last_reply_client: instant(last_reply_client, current?.last_reply_client ?? null),
    })
    .eq("id", id)
    .select("id");
  if (error) back(id, "error=save");
  if (!data || data.length === 0) back(id, "error=owner_only");
  refreshed(id);
  back(id, "saved=client");
}

const Touch = z.object({
  kind: z.enum(["call", "loom", "report", "slack", "email"]),
  note: z.string().max(4000).nullable(),
});

/** Any staff member logs a touch. A database trigger moves the clinic's last contact (us) forward. */
export async function addTouch(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("client_id"));
  const parsed = Touch.safeParse({ kind: formData.get("kind"), note: blank(formData.get("note")) });
  if (!parsed.success) back(id, "error=touch");
  const supabase = await createClient();
  const { error } = await supabase.from("touches").insert({ client_id: id, by_id: me.id, ...parsed.data! });
  if (error) back(id, "error=touch_save");
  refreshed(id);
  back(id, "saved=touch");
}

const Location = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullable(),
  doctors: z.array(z.string().min(1).max(200)).max(50),
  price_points: z.string().max(2000).nullable(),
  calendar_url: z.url().max(1000).nullable(),
});
const locationFrom = (formData: FormData) =>
  Location.safeParse({
    name: blank(formData.get("name")) ?? "",
    address: blank(formData.get("address")),
    doctors: String(formData.get("doctors") ?? "").split(",").map((d) => d.trim()).filter(Boolean),
    price_points: blank(formData.get("price_points")),
    calendar_url: blank(formData.get("calendar_url")),
  });

/** Owner adds a location to the clinic sheet. */
export async function addLocation(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("client_id"));
  if (me.role !== "owner") back(id, "error=owner_only");
  const parsed = locationFrom(formData);
  if (!parsed.success) back(id, "error=location");
  const supabase = await createClient();
  const { error } = await supabase.from("client_locations").insert({ client_id: id, ...parsed.data! });
  if (error) back(id, error.code === "42501" ? "error=owner_only" : "error=save");
  refreshed(id);
  back(id, "saved=location");
}

/** Owner edits a location. */
export async function updateLocation(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("client_id"));
  const locationId = Id.parse(formData.get("location_id"));
  if (me.role !== "owner") back(id, "error=owner_only");
  const parsed = locationFrom(formData);
  if (!parsed.success) back(id, "error=location");
  const supabase = await createClient();
  const { data, error } = await supabase.from("client_locations").update(parsed.data!).eq("id", locationId).eq("client_id", id).select("id");
  if (error) back(id, "error=save");
  if (!data || data.length === 0) back(id, "error=owner_only");
  refreshed(id);
  back(id, "saved=location");
}

/** Owner removes a location. Soft delete: the row stays, marked deleted. */
export async function removeLocation(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("client_id"));
  const locationId = Id.parse(formData.get("location_id"));
  if (me.role !== "owner") back(id, "error=owner_only");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_locations").update({ deleted_at: new Date().toISOString() }).eq("id", locationId).eq("client_id", id).select("id");
  if (error) back(id, "error=save");
  if (!data || data.length === 0) back(id, "error=owner_only");
  refreshed(id);
  back(id, "saved=location_removed");
}

/** Owner stores a clinic's client-dashboard login (sent to the clinic in its Monday outcome message). */
export async function saveDashboardLogin(formData: FormData) {
  const me = await requireStaff();
  const id = Id.parse(formData.get("id"));
  if (me.role !== "owner") back(id, "error=owner_only");
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();
  if (!username || !password || username.length > 200 || password.length > 200) back(id, "error=invalid");
  const supabase = await createClient();
  const { error } = await supabase.from("client_dashboard_logins").upsert({ client_id: id, username, password, updated_by: me.id }, { onConflict: "client_id" });
  if (error) back(id, "error=save");
  back(id, "saved=login");
}
