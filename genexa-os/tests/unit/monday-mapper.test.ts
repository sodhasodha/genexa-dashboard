import { describe, expect, it } from "vitest";
import {
  adityaCategory, cleanClientName, isPlaceholderStaff, isVitaleSplitItem, mapClient, mapDeletedItems, mapStaff,
  mapTask, mapTechJob, matchClient, matchCortanaBusiness, type MondayBoard, type MondayItem, type Unmapped,
} from "@/lib/integrations/monday/mapper";
import fixture from "../../fixtures/monday/boards_redacted.json";
import cortana from "../../fixtures/cortana/businesses.json";

const boards = fixture as unknown as Record<string, MondayBoard>;
const item = (board: MondayBoard, name: string): MondayItem => {
  const found = board.items_page.items.find((i) => i.name === name);
  if (!found) throw new Error(`fixture has no item "${name}"`);
  return found;
};

describe("clients", () => {
  it("strips the pod suffix whatever its casing", () => {
    expect(cleanClientName("Pure Health medical Pod 1")).toBe("Pure Health medical");
    expect(cleanClientName("Terry L Franklin MD POd 2")).toBe("Terry L Franklin MD");
    expect(cleanClientName("Beyond Stem Cells pOd 2")).toBe("Beyond Stem Cells");
    expect(cleanClientName("Multivita IV")).toBe("Multivita IV");
  });

  it("maps a live 30-day client with a guarantee", () => {
    const unmapped: Unmapped[] = [];
    const row = mapClient(boards.clients, item(boards.clients, "Pure Health medical Pod 1"), unmapped);
    expect(row).toMatchObject({
      name: "Pure Health medical", stage: "live", pod: "pod_1", billing_cycle: "30", cycle_fee: 1500,
      launch_date: "2026-09-08", guarantee_text: "$4,500 revenue in 30 days (modified)", guarantee_target_amount: 4500,
      guarantee_deadline: "2026-10-08", ob_form_status: "Completed",
    });
    expect(row.kickoff_url).toMatch(/^https:\/\//);
    expect(row.last_contact_us).toBe("2026-09-08T16:00:00Z");
    expect(unmapped).toEqual([]);
  });

  it("keeps blanks as null and reports them instead of inventing values", () => {
    const unmapped: Unmapped[] = [];
    const row = mapClient(boards.clients, item(boards.clients, "Multivita IV"), unmapped);
    expect(row).toMatchObject({ pod: null, billing_cycle: null, cycle_fee: null, launch_date: null, guarantee_target_amount: null });
    expect(unmapped.map((u) => u.problem).join(" | ")).toMatch(/No Billing Cycle.*No Monthly Fee.*no Launch Date/);
  });

  it("stores a 90-day fee per cycle, not as the rounded monthly figure", () => {
    const row = mapClient(boards.clients, item(boards.clients, "Georgia Interventional Pain Consultants Pod 2"), []);
    expect(row).toMatchObject({ billing_cycle: "90", cycle_fee: 5000 });
  });

  it("maps legacy billing and the churned group", () => {
    const unmapped: Unmapped[] = [];
    expect(mapClient(boards.clients, item(boards.clients, "Dr Darren - Pivotal Health (Lake Worth)"), unmapped).billing_cycle).toBe("legacy");
    const churned = mapClient(boards.clients, item(boards.clients, "CC Medical (Chris Calapai)"), unmapped);
    expect(churned.stage).toBe("churned");
    expect(churned.pod).toBeNull();
  });
});

describe("team", () => {
  it("skips placeholder hires and maps roles", () => {
    expect(isPlaceholderStaff("CSR hire 5")).toBe(true);
    const unmapped: Unmapped[] = [];
    expect(mapStaff(boards.team, item(boards.team, "CSR hire 5"), unmapped)).toBeNull();
    const amanda = mapStaff(boards.team, item(boards.team, "Amanda Harder"), unmapped);
    expect(amanda?.staff).toMatchObject({ role: "csr", pod: "pod_2", status: "active", start_date: "2026-09-09" });
    expect(amanda?.pay.hourly_rate).toBe(1);
    const aditya = mapStaff(boards.team, item(boards.team, "Aditya"), unmapped);
    expect(aditya?.staff).toMatchObject({ role: "media_buyer", also_role: "call_centre_manager", status: "at_risk", pod: null });
    expect(unmapped).toEqual([]);
  });
});

describe("tasks", () => {
  it("maps Ryan's list and Aditya's list, including Done as history", () => {
    const unmapped: Unmapped[] = [];
    const ryan = mapTask(boards.ryan, item(boards.ryan, "Hire 4 CSRs (2 new pods)"), "ryan", unmapped);
    expect(ryan).toMatchObject({ task_group: "week", priority: "high", source: "ryan", status: "todo", category: "general" });
    const done = mapTask(boards.aditya, item(boards.aditya, "Multivita ads not spending - check ad account"), "aditya", unmapped);
    expect(done).toMatchObject({ task_group: "done", status: "done", source: "claude", category: "ads", due: "2026-09-23", client_text: "Multivita IV" });
    expect(done?.done_at).not.toBeNull();
    expect(unmapped).toEqual([]);
  });

  it("categorises Aditya's items as ads or call centre", () => {
    expect(adityaCategory("Mitch change price to $2,999 on all ads")).toBe("ads");
    expect(adityaCategory("Coach Marjorie Grace Villarino - 0 confirmations logged in 7 days")).toBe("call_centre");
    expect(adityaCategory("Pod 1 - 8 consults sit on Monday 28 Sep, Ryan asked for 4x call attempts each")).toBe("call_centre");
    expect(adityaCategory("Fix Pivotal leads not logging on Meta")).toBe("ads");
  });

  it("recognises the Vitale item that splits between Aditya and Sameer", () => {
    expect(isVitaleSplitItem("vitale ^ new location + ad account launch $2,999 ads + add location to script and GHL location")).toBe(true);
    expect(isVitaleSplitItem("Launch Vitale ads Tue 22 Sep")).toBe(false);
  });
});

describe("tech jobs", () => {
  it("keeps the original creation time and skips the blank Task row", () => {
    const unmapped: Unmapped[] = [];
    const job = mapTechJob(boards.sameer, item(boards.sameer, "Launch Mitchell New Rockwall Location"), unmapped);
    expect(job).toMatchObject({ type: "launch", status: "todo", requested_at: "2026-10-04T23:36:40Z" });
    expect(unmapped[0].problem).toMatch(/No Type/);
    expect(mapTechJob(boards.sameer, item(boards.sameer, "Task"), unmapped)).toBeNull();
  });
});

describe("deleted items", () => {
  it("takes delete_pulse names and converts Monday's timestamp", () => {
    const rows = mapDeletedItems([
      { id: "1", event: "delete_pulse", created_at: "17912906296483254", data: JSON.stringify({ pulse_id: 42, pulse_name: "Launch Vitale ads Tue 22 Sep" }) },
      { id: "2", event: "batch_delete_pulses", created_at: "17912906296573158", data: JSON.stringify({ pulse_ids: [42] }) },
      { id: "3", event: "update_name", created_at: "17912906296573158", data: JSON.stringify({ pulse_id: 43, pulse_name: "x" }) },
    ]);
    expect(rows).toEqual([{ legacy_ref: "42", title: "Launch Vitale ads Tue 22 Sep", deleted_at: "2026-10-06T12:43:49.648Z" }]);
  });
});

describe("matching", () => {
  const clients = [
    { name: "Vitale Health Clinic", contact_name: "Mitch Duquesnel" },
    { name: "Terry L Franklin MD", contact_name: "Tel Franklin" },
    { name: "Dr Darren - Pivotal Health (Lake Worth)", contact_name: null },
    { name: "Regen RX", contact_name: "Joyce Martin" },
    { name: "Regenestem", contact_name: "Rick De Cubas" },
  ];
  it("resolves a task's client text to exactly one client, by clinic or contact name", () => {
    expect(matchClient("Mitch", clients)?.name).toBe("Vitale Health Clinic");
    expect(matchClient("Terry Franklin", clients)?.name).toBe("Terry L Franklin MD");
    expect(matchClient("Dr Darren - Pivotal Health", clients)?.name).toBe("Dr Darren - Pivotal Health (Lake Worth)");
    expect(matchClient("Regen RX, Regenestem, Pivotal, Multivita", clients)).toBeNull();
    expect(matchClient("Holistique", clients)).toBeNull();
    expect(matchClient(null, clients)).toBeNull();
  });

  const businesses = (cortana as { data: { id: string; name: string }[] }).data;
  it("matches clinics to real Cortana businesses and leaves unclear ones blank", () => {
    const m = (name: string) => matchCortanaBusiness(name, businesses);
    expect(m("Pure Health medical").match).toMatchObject({ business_name: "Pure Health Medical", confidence: "exact" });
    expect(m("Regen RX").match).toMatchObject({ business_name: "Regen Rx", confidence: "exact" });
    expect(m("Regenestem").match).toMatchObject({ business_name: "Regenestem", confidence: "exact" });
    expect(m("Beyond Stem Cells").match).toMatchObject({ business_name: "Beyond Stem Cells LLC", confidence: "exact" });
    expect(m("Vitale Health Clinic").match).toMatchObject({ business_name: "Vitale Health LLC", confidence: "likely" });
    expect(m("Georgia Interventional Pain Consultants").match).toMatchObject({ business_name: "Interventional Pain Consultants - Georgia" });
    expect(m("dr gabriel").match).toBeNull();
    expect(m("Holistique").match).toBeNull();
    // "icp" is not "Interventional Pain Consultants": only the city matches, so it stays blank with a candidate.
    const cleveland = m("cleveland icp");
    expect(cleveland.match).toBeNull();
    expect(cleveland.candidates.map((c) => c.business_name)).toEqual(["Interventional Pain Consultants - Cleveland"]);
  });
});
