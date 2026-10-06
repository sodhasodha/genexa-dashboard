"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";

const Email = z.email();

/** Sends a magic link. Only existing team members get one; the reply never reveals which. */
export async function sendMagicLink(formData: FormData) {
  const parsed = Email.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) redirect("/login?error=email");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { shouldCreateUser: false, emailRedirectTo: `${appUrl()}/auth/confirm` },
  });
  // "Signups not allowed for otp" means the email is not on the team: same reply as success.
  if (error && error.status !== 422 && error.code !== "otp_disabled") {
    redirect("/login?error=send");
  }
  redirect("/login?sent=1");
}
