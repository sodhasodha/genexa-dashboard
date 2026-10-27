"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const Credentials = z.object({ email: z.email(), password: z.string().min(1).max(200) });

/** Email + password sign-in. The reply never says which of the two was wrong. */
export async function signIn(formData: FormData) {
  const parsed = Credentials.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) redirect("/login?error=invalid");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) redirect(`/login?error=${error.status === 429 ? "rate" : "wrong"}&email=${encodeURIComponent(parsed.data.email)}`);
  // CSRs go straight to the desk, so the address bar says /confirmations and the desk's filters work.
  const { data: me } = await supabase.from("staff").select("role").eq("auth_user_id", data.user.id).neq("status", "left").maybeSingle();
  redirect(me?.role === "csr" ? "/confirmations" : "/");
}
