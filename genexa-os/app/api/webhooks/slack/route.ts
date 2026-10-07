import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { respondToInteraction } from "@/lib/slack/client";
import { verifySlackSignature } from "@/lib/slack/signature";
import { supabaseRpc } from "@/lib/reminders/engine";
import { handleInteraction, parseInteractionBody, type InteractionReply } from "@/lib/reminders/interaction";

// Slack interactivity: the Done / Snooze 1h buttons on reminders.
// Authenticated by Slack's request signature (SLACK_SIGNING_SECRET), nothing else.
export const maxDuration = 10;

export async function POST(request: NextRequest) {
  // The signature covers the exact bytes Slack sent, so the body is read raw.
  const body = await request.text();
  const check = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body,
  });
  if (!check.ok) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const payload = parseInteractionBody(body);
  if (!payload) return NextResponse.json({ error: "no payload" }, { status: 400 });

  let reply: InteractionReply;
  try {
    reply = await handleInteraction(payload, { rpc: supabaseRpc(createAdminClient()) });
  } catch (err) {
    console.error("slack interaction failed", err);
    reply = { replace_original: false, response_type: "ephemeral", text: "Genexa OS could not save that. Nothing was changed; open the app instead." };
  }
  if (payload.response_url) await respondToInteraction(payload.response_url, reply).catch(() => false);
  // An empty 200 is the acknowledgement Slack waits for (3 second limit).
  return new NextResponse(null, { status: 200 });
}
