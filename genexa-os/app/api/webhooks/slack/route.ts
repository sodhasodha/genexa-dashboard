import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { respondToInteraction } from "@/lib/slack/client";
import { workspaceByTeamId, workspaceFromSignature } from "@/lib/slack/workspaces";
import { supabaseRpc } from "@/lib/reminders/engine";
import { handleInteraction, parseInteractionBody, type InteractionReply } from "@/lib/reminders/interaction";
import { postFromEventBody } from "@/lib/router/events";
import { ingestClientMessage } from "@/lib/router/ingest";
import { processRequest } from "@/lib/router/process";
import { classifierConfigured, ingestDeps, processDeps } from "@/lib/router/runtime";

// Slack requests from both workspaces arrive here, each signed with its own
// install's secret. Team workspace: the Done / Snooze 1h buttons on reminders.
// Client workspace: message events from clients' channels feed the request
// router. The only thing that can ever go back there is a thread reply, and only
// while client_workspace_thread_replies is on (lib/slack/workspaces.ts).
// The time limit covers the classification that runs after Slack has its answer.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // The signature covers the exact bytes Slack sent, so the body is read raw.
  const body = await request.text();
  const workspace = workspaceFromSignature({
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body,
  });
  if (!workspace) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  // Events API handshake and events (JSON bodies).
  if (request.headers.get("content-type")?.includes("application/json")) {
    let event: { type?: string; challenge?: string; team_id?: string };
    try {
      event = JSON.parse(body) as typeof event;
    } catch {
      return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    if (event.type === "url_verification" && event.challenge) return NextResponse.json({ challenge: event.challenge });
    // The signing secret and the team id must agree about which workspace this is.
    if (event.team_id && workspaceByTeamId(event.team_id) !== workspace) return NextResponse.json({ error: "workspace mismatch" }, { status: 401 });
    // Team-workspace events are acknowledged and not acted on.
    if (workspace !== "client") return new NextResponse(null, { status: 200 });

    // Text or not: a staff reply that is only a file still clears a Triage item.
    const found = postFromEventBody(event);
    if ("ignored" in found) return new NextResponse(null, { status: 200 });
    try {
      // A staff message is not stored: it marks the Triage rows it answers "Handled in Slack".
      // Stored first (once per channel + ts, so a Slack retry adds nothing), then
      // acknowledged. Classifying happens after the response; the router-process
      // job picks the message up if that is cut short.
      const db = createAdminClient();
      const stored = await ingestClientMessage(found.message, ingestDeps(db));
      if (stored.action === "stored" && classifierConfigured()) {
        after(async () => {
          await processRequest(stored.id, processDeps(db)).catch((err) => console.error("router: processing failed", err));
        });
      }
    } catch (err) {
      // Not stored: a 500 makes Slack send it again.
      console.error("router: could not store client message", { retry: request.headers.get("x-slack-retry-num"), err });
      return NextResponse.json({ error: "not stored" }, { status: 500 });
    }
    return new NextResponse(null, { status: 200 });
  }
  // Buttons only exist on messages with buttons, and the app sends none of those to the client workspace.
  if (workspace === "client") return new NextResponse(null, { status: 200 });

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
