"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const Email = z.email();
// Supabase sends a numeric one-time code; its length is a project setting (6 to 10 digits).
const Code = z.string().regex(/^\d{6,10}$/);

/** Step 1: email a one-time code. Only existing team members get one; the reply never reveals which. */
export async function sendCode(formData: FormData) {
  const parsed = Email.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) redirect("/login?error=email");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ email: parsed.data, options: { shouldCreateUser: false } });
  // "Signups not allowed for otp" means the email is not on the team: same reply as success.
  if (error && error.status !== 422 && error.code !== "otp_disabled") {
    redirect(`/login?error=${error.status === 429 ? "rate" : "send"}`);
  }
  redirect(`/login?step=code&email=${encodeURIComponent(parsed.data)}`);
}

/** Step 2: sign in with the code. Works on any device: nothing depends on the browser that asked for it. */
export async function verifyCode(formData: FormData) {
  const email = Email.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  const code = Code.safeParse(String(formData.get("code") ?? "").replace(/\s+/g, ""));
  if (!email.success) redirect("/login?error=email");
  if (!code.success) redirect(`/login?step=code&email=${encodeURIComponent(email.data)}&error=code`);

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: email.data, token: code.data, type: "email" });
  if (error) redirect(`/login?step=code&email=${encodeURIComponent(email.data)}&error=code`);
  redirect("/");
}
