import { describe, expect, it } from "vitest";
import { buildUserMessage, extractOutcomes, mightMentionOutcome, parseFound } from "@/lib/outcome-proposals/extract";
import { outcomeText, proposalBlocks } from "@/lib/outcome-proposals/compose";

describe("spotting outcomes in a clinic message", () => {
  it("only sends messages that might report an outcome to the model", () => {
    expect(mightMentionOutcome("Maria no showed")).toBe(true);
    expect(mightMentionOutcome("she didn't show up today")).toBe(true);
    expect(mightMentionOutcome("Jane came in and bought the package")).toBe(true);
    expect(mightMentionOutcome("Can you block Dr Patel's calendar on Friday?")).toBe(false);
    expect(mightMentionOutcome("thanks!")).toBe(false);
  });
  it("puts the thread's first message in front of the reply", () => {
    expect(buildUserMessage({ text: "she no showed", threadStart: "Booked: Maria Lopez, Tue 2pm", clientName: "Pivotal" })).toBe(
      "Clinic: Pivotal\n\n<thread_start>\nBooked: Maria Lopez, Tue 2pm\n</thread_start>\n\n<clinic_message>\nshe no showed\n</clinic_message>",
    );
  });
  it("keeps confident outcomes, drops amounts on anything but a close", () => {
    expect(parseFound({ outcomes: [
      { patient_first: "Maria", patient_last: "", outcome: "no_show", amount: 500, confidence: 0.9 },
      { patient_first: "Jane", patient_last: "D", outcome: "closed_won", amount: 6000, confidence: 0.95 },
      { patient_first: "Bob", patient_last: null, outcome: "not_closed", amount: null, confidence: 0.4 },
    ] })).toEqual([
      { patient_first: "Maria", patient_last: null, outcome: "no_show", amount: null, confidence: 0.9 },
      { patient_first: "Jane", patient_last: "D", outcome: "closed_won", amount: 6000, confidence: 0.95 },
    ]);
    expect(() => parseFound({ outcomes: [{ patient_first: "X", patient_last: null, outcome: "showed", amount: null, confidence: 1 }] })).toThrow();
  });
  it("asks the model with structured output and reads its answer", async () => {
    let sent: { model?: string; output_config?: { format?: { type?: string } } } = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ outcomes: [{ patient_first: "Maria", patient_last: null, outcome: "no_show", amount: null, confidence: 0.92 }] }) }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const found = await extractOutcomes({ text: "Maria no showed", threadStart: null, clientName: "Pivotal" }, { apiKey: "k", fetch: fakeFetch });
    expect(found).toEqual([{ patient_first: "Maria", patient_last: null, outcome: "no_show", amount: null, confidence: 0.92 }]);
    expect(sent.output_config?.format?.type).toBe("json_schema");
    // No outcome words: the model is not asked at all.
    expect(await extractOutcomes({ text: "can you pause the ads", threadStart: null, clientName: "Pivotal" }, { apiKey: "k", fetch: (() => { throw new Error("called"); }) as unknown as typeof fetch })).toEqual([]);
  });
});

describe("the owner's DM", () => {
  const view = {
    id: "11111111-1111-1111-1111-111111111111", clinic: "Pivotal Health", message: "Maria no showed <b>", permalink: "https://slack.com/x",
    patient: "Maria", outcome: "no_show" as const, amount: null, timezone: "America/New_York",
    candidates: [
      { contact_id: "c1", name: "Maria Lopez", stage: "Booked", appointment: "2026-10-22T18:00:00Z" },
      { contact_id: "c2", name: "Maria Garcia", stage: "Booked", appointment: null },
    ],
  };
  it("has a Confirm per matching patient and an Ignore, all carrying the proposal id", () => {
    const { text, blocks } = proposalBlocks(view);
    expect(text).toBe("Pivotal Health: log Maria as No Show?");
    const actions = blocks.find((b) => (b as { type: string }).type === "actions") as { block_id: string; elements: { action_id: string; value: string; text: { text: string } }[] };
    expect(actions.block_id).toBe(`act:outcome_proposals:${view.id}`);
    expect(actions.elements.map((e) => [e.action_id, e.value, e.text.text])).toEqual([
      ["outcome_confirm_0", `${view.id}:c1`, "Confirm: Maria Lopez"],
      ["outcome_confirm_1", `${view.id}:c2`, "Confirm: Maria Garcia"],
      ["outcome_ignore", `${view.id}:`, "Ignore"],
    ]);
    expect(JSON.stringify(blocks)).toContain("&lt;b&gt;");
  });
  it("offers nothing to confirm when no patient matches", () => {
    const { blocks } = proposalBlocks({ ...view, candidates: [] });
    expect(blocks.some((b) => (b as { type: string }).type === "actions")).toBe(false);
  });
  it("words a close with and without an amount", () => {
    expect(outcomeText({ outcome: "closed_won", amount: 6000 })).toBe("Closed for $6,000");
    expect(outcomeText({ outcome: "closed_won", amount: null })).toBe("Closed, amount not given (clinic will be asked for it)");
  });
});
