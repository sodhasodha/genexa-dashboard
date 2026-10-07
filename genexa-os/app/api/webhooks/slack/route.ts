import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { respondToInteraction } from "@/lib/slack/client";
import { workspaceByTeamId, workspaceFromSignature } from "@/lib/slack/workspaces";
import { supabaseRpc } from "@/lib/reminders/engine";
import { handleInteraction, parseInteractionBody, type InteractionReply } from "@/lib/reminders/interaction";

// Slack requests from both workspaces arrive here, each signed with its own
// install's secret. Team workspace: the Done / Snooze 1h buttons on reminders.
// Client workspace: listen-only. Nothing it sends can trigger a message back
// (the request router that will read its messages is not built yet).
export const maxDuration = 10;

export async function POST(request: NextRequest) {
  // The signature covers the exact bytes Slack sent, so the body is read raw.
  const body = await request.text();
  const workspace = workspaceFromSignature({
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body,
  });
  if (!workspace) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  // Events API handshake and events (JSON bodies). Accepted from either workspace and acknowledged;
  // no event is acted on yet.
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const event = JSON.parse(body) as { type?: string; challenge?: string; team_id?: string };
      if (event.type === "url_verification" && event.challenge) return NextResponse.json({ challenge: event.challenge });
      // The signing secret and the team id must agree about which workspace this is.
      if (event.team_id && workspaceByTeamId(event.team_id) !== workspace) return NextResponse.json({ error: "workspace mismatch" }, { status: 401 });
    } catch {
      return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    return new NextResponse(null, { status: 200 });
  }
  // Buttons only exist on messages the app sent, and it sends none to the client workspace.
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
