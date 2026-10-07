import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleOnboarding, type IntakeResult } from "@/lib/webhooks/onboarding";

// Called by the onboarding form with "x-webhook-secret: WEBHOOK_SECRET" (or a Bearer token).
// Everything it writes happens inside onboarding_intake (SQL), in one transaction.
export async function POST(request: NextRequest) {
  return handleOnboarding(request, {
    secret: process.env.WEBHOOK_SECRET,
    intake: async (body) => {
      const { data, error } = await createAdminClient().rpc("onboarding_intake", {
        p_event_id: body.event_id,
        p_clinic_name: body.clinic_name,
        p_contact_name: body.contact_name ?? null,
        p_contact_email: body.contact_email ?? null,
        p_billing_cycle: body.billing_cycle ?? null,
        p_cycle_fee: body.cycle_fee ?? null,
        p_paid_at: body.paid_at ?? null,
        p_ob_form_done_at: body.ob_form_done_at ?? null,
        p_kickoff_url: body.kickoff_url ?? null,
        p_drive_url: body.drive_url ?? null,
        p_pod: body.pod ?? null,
      });
      if (error) throw new Error(`onboarding_intake: ${error.message}`);
      return data as IntakeResult;
    },
  });
}
