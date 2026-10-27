import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "./nav";

export type CurrentStaff = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  also_role: string | null;
  pod: string | null;
  timezone: string;
};

export type Session =
  | { kind: "anonymous" }
  | { kind: "not_staff"; email: string | null }
  | { kind: "staff"; staff: CurrentStaff };

/** Who is making this request. One lookup per request. */
export const getSession = cache(async (): Promise<Session> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { kind: "anonymous" };
  const { data: staff } = await supabase
    .from("staff")
    .select("id, name, email, role, also_role, pod, timezone")
    .eq("auth_user_id", data.user.id)
    .neq("status", "left")
    .maybeSingle();
  if (!staff) return { kind: "not_staff", email: data.user.email ?? null };
  return { kind: "staff", staff: staff as CurrentStaff };
});

/** Anyone signed in and on the team, CSRs included. Only the confirmation desk uses this directly. */
async function requireSession(): Promise<CurrentStaff> {
  const session = await getSession();
  if (session.kind === "anonymous") redirect("/login");
  if (session.kind === "not_staff") redirect("/login?error=not_staff");
  return session.staff;
}

/**
 * The logged-in staff member, or a redirect to /login. A CSR is sent to the
 * confirmation desk: every page and server action outside it refuses CSRs.
 */
export async function requireStaff(): Promise<CurrentStaff> {
  const staff = await requireSession();
  if (staff.role === "csr") redirect("/confirmations");
  return staff;
}

/** The confirmation desk: CSRs and the owner. */
export async function requireDeskUser(): Promise<CurrentStaff> {
  const staff = await requireSession();
  if (staff.role !== "csr" && staff.role !== "owner") redirect("/");
  return staff;
}

export async function requireOwner(): Promise<CurrentStaff> {
  const staff = await requireStaff();
  if (staff.role !== "owner") redirect("/");
  return staff;
}
