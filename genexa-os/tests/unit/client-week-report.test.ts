import { describe, expect, it } from "vitest";
import { composeClientWeekReport, shortDate, type ClientWeekRow } from "@/lib/reports/clientWeek";
import { composeOwnerMessage, runWeeklyClientReport, type SendResult } from "@/lib/reports/weeklyClientReport";
import { runDailySnapshot } from "@/lib/jobs/dailySnapshot";
import type { Rpc } from "@/lib/jobs/rpc";

const row = (over: Partial<ClientWeekRow> = {}): ClientWeekRow => ({
  client_id: "c1", client_name: "Pivotal Health", week_start: "2026-09-28", week_end: "2026-10-04",
  spend: 1200, leads: 40, booked: 12, confirmed: 9, shows: 7, no_shows: 2, closes: 3, revenue: 15000,
  cost_per_booked: 100, show_rate: 7 / 9,
  prev_spend: 1000, prev_leads: 40, prev_booked: 15, prev_confirmed: 9, prev_shows: 6, prev_no_shows: 4, prev_closes: 0, prev_revenue: 0,
  prev_cost_per_booked: 66.67, prev_show_rate: 0.6,
  ...over,
});
const NULLS: Partial<ClientWeekRow> = {
  spend: null, leads: null, booked: null, confirmed: null, shows: null, no_shows: null, closes: null, revenue: null, cost_per_booked: null, show_rate: null,
  prev_spend: null, prev_leads: null, prev_booked: null, prev_confirmed: null, prev_shows: null, prev_no_shows: null, prev_closes: null, prev_revenue: null,
  prev_cost_per_booked: null, prev_show_rate: null,
};

describe("composeClientWeekReport", () => {
  it("writes the week in plain English with the week before alongside", () => {
    expect(composeClientWeekReport(row())).toBe(
      [
        "# Pivotal Health",
        "",
        "Week of 28 Sep to 4 Oct 2026, compared with the week before.",
        "",
        "40 leads came in and 12 consultations were booked. 7 patients showed and 3 sales closed for $15,000 in revenue.",
        "",
        "- Ad spend: $1,200 (week before: $1,000, up 20%)",
        "- Leads: 40 (week before: 40, no change)",
        "- Consultations booked: 12 (week before: 15, down 20%)",
        "- Confirmed: 9 (week before: 9, no change)",
        "- Showed: 7 (week before: 6, up 17%)",
        "- No-shows: 2 (week before: 4, down 50%)",
        "- Show rate: 77.8% (week before: 60.0%, up 17.8 points)",
        "- Closed: 3 (week before: 0)",
        "- Revenue: $15,000 (week before: $0.00)",
        "- Cost per booked consultation: $100.00 (week before: $66.67, up 50%)",
        "",
      ].join("\n"),
    );
  });

  it('prints "no data" for every null and never a zero', () => {
    const text = composeClientWeekReport(row(NULLS));
    expect(text).toContain('Some of this week\'s numbers are missing. They show as "no data" below.');
    expect(text.match(/no data \(week before: no data\)/g)).toHaveLength(10);
    expect(text).not.toMatch(/\$0|: 0 |NaN|null|undefined/);
  });

  it("keeps a real zero as zero and handles singular counts", () => {
    const text = composeClientWeekReport(row({ leads: 1, booked: 1, shows: 1, closes: 0, revenue: 0, show_rate: null, cost_per_booked: null, prev_spend: null }));
    expect(text).toContain("1 lead came in and 1 consultation was booked. 1 patient showed and 0 sales closed.");
    expect(text).toContain("- Ad spend: $1,200 (week before: no data)");
    expect(text).toContain("- Closed: 0 (week before: 0, no change)");
    expect(text).toContain("- Show rate: no data (week before: 60.0%)");
  });

  it("reads numbers that arrive as strings", () => {
    const text = composeClientWeekReport(row({ spend: "250.00", prev_spend: "200.00" }));
    expect(text).toContain("- Ad spend: $250.00 (week before: $200.00, up 25%)");
  });

  it("uses nothing but the clinic name and its numbers", () => {
    const withExtras = { ...row(), contact_first_name: "Zebediah", patient: "Zebediah Smith", email: "z@example.test", phone: "+15550100" } as ClientWeekRow;
    const text = composeClientWeekReport(withExtras);
    expect(text).not.toMatch(/Zebediah|Smith|example\.test|5550100/);
    expect(text).toBe(composeClientWeekReport(row()));
  });

  it("formats dates in the calendar they were given", () => {
    expect(shortDate("2026-01-01")).toBe("1 Jan");
    expect(shortDate("2026-12-31", true)).toBe("31 Dec 2026");
  });
});

describe("composeOwnerMessage", () => {
  const base = { weekStart: "2026-09-28", weekEnd: "2026-10-04", clientsUrl: "https://os.test/clients" };
  it("lists red clinics with reasons, the report count and the link", () => {
    expect(composeOwnerMessage({ ...base, prepared: 5, red: [{ name: "A Clinic", reasons: "$0 ad spend 24h+ · Renewal overdue since 01 Oct" }, { name: "B Clinic", reasons: null }] })).toBe(
      [
        "5 client reports prepared for 28 Sep to 4 Oct.",
        "Red clinics (2):",
        "• A Clinic: $0 ad spend 24h+ · Renewal overdue since 01 Oct",
        "• B Clinic: no reason recorded",
        "https://os.test/clients",
      ].join("\n"),
    );
  });
  it("says so when nothing is red", () => {
    expect(composeOwnerMessage({ ...base, prepared: 1, red: [] })).toBe("1 client report prepared for 28 Sep to 4 Oct.\nNo red clinics.\nhttps://os.test/clients");
  });
});

// The jobs against a fake database: which SQL functions they call, in what order, and with what.
function fakeRpc(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    if (!(fn in answers)) throw new Error(`unexpected rpc: ${fn}`);
    const a = answers[fn];
    return (typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : a) as T;
  };
  return { rpc, calls };
}

describe("runDailySnapshot (fake database)", () => {
  const answers = { snapshot_person_scores: { week_start: "2026-10-05", rows: 12 }, freeze_agency_month: { frozen: true, month: "2026-09-01" } };

  it("snapshots yesterday's week and leaves the month alone mid-month", async () => {
    const { rpc, calls } = fakeRpc(answers);
    const r = await runDailySnapshot({ rpc, today: "2026-10-07" });
    expect(calls).toEqual([{ fn: "snapshot_person_scores", args: { p_day: "2026-10-06" } }]);
    expect(r).toEqual({ ok: true, summary: { scores: answers.snapshot_person_scores, agency_month: null } });
  });

  it("on Monday the snapshot is last week's final numbers; on the 1st it freezes last month", async () => {
    const monday = fakeRpc(answers);
    await runDailySnapshot({ rpc: monday.rpc, today: "2026-10-05" });
    expect(monday.calls[0].args).toEqual({ p_day: "2026-10-04" }); // Sunday

    const first = fakeRpc(answers);
    await runDailySnapshot({ rpc: first.rpc, today: "2027-01-01" });
    expect(first.calls[1]).toEqual({ fn: "freeze_agency_month", args: { p_month: "2026-12-31" } });
  });

  it("freezes a named month as a back-fill, and lets a database error surface", async () => {
    const { rpc, calls } = fakeRpc(answers);
    await runDailySnapshot({ rpc, today: "2026-10-07", month: "2026-08-01" });
    expect(calls[1]).toEqual({ fn: "freeze_agency_month", args: { p_month: "2026-08-01" } });
    await expect(runDailySnapshot({ rpc: fakeRpc({}).rpc, today: "2026-10-07" })).rejects.toThrow(/unexpected rpc/);
  });
});

describe("runWeeklyClientReport (fake database)", () => {
  const digest = { owner_id: "owner-1", slack_user_id: "U1", owner_email: "ryan@example.test", red: [{ name: "Red Clinic", reasons: "$0 ad spend 24h+" }] };

  function setup(over: Record<string, unknown> = {}) {
    let claimed = false;
    const sent: { to: string; text: string }[] = [];
    const fake = fakeRpc({
      client_week_report: [row(), row({ client_id: "c2", client_name: "Multivita IV" })],
      store_client_report: { stored: true },
      weekly_report_digest: digest,
      // Like the unique index: the first claim of a week wins.
      weekly_report_claim: () => (claimed ? null : ((claimed = true), "note-1")),
      weekly_report_sent: null,
      ...over,
    });
    const send = async (to: string, text: string): Promise<SendResult> => {
      sent.push({ to, text });
      return { ok: true, ts: "111.222", channel: "D1" };
    };
    const run = (today = "2026-10-05") => runWeeklyClientReport({ rpc: fake.rpc, send, today, appUrl: "https://os.test" });
    return { ...fake, sent, run };
  }

  it("reports on the Monday-to-Sunday week before today", async () => {
    for (const today of ["2026-10-05", "2026-10-07", "2026-10-11"]) {
      const { calls, run } = setup();
      await run(today);
      expect(calls[0]).toEqual({ fn: "client_week_report", args: { p_week_start: "2026-09-28" } });
    }
  });

  it("stores each report, claims the week, sends once and records the send", async () => {
    const { calls, sent, run } = setup();
    const r = await run();
    expect(r).toEqual({ ok: true, summary: { week_start: "2026-09-28", reports: 2, red: 1, dm: "sent" } });
    expect(calls.map((c) => c.fn)).toEqual([
      "client_week_report", "store_client_report", "store_client_report", "weekly_report_digest", "weekly_report_claim", "weekly_report_sent",
    ]);
    expect(calls[1].args).toMatchObject({ p_client_id: "c1", p_week_start: "2026-09-28", p_numbers: row() });
    expect(calls[1].args.p_body).toBe(composeClientWeekReport(row()));
    expect(calls[4].args).toEqual({ p_week_start: "2026-09-28", p_staff_id: "owner-1" });
    expect(calls[5].args).toEqual({ p_id: "note-1", p_ok: true, p_slack_ts: "111.222", p_channel: "D1" });
    expect(sent).toEqual([{ to: "U1", text: "2 client reports prepared for 28 Sep to 4 Oct.\nRed clinics (1):\n• Red Clinic: $0 ad spend 24h+\nhttps://os.test/clients" }]);
  });

  it("does not send a second time in the same week", async () => {
    const { sent, run } = setup();
    await run("2026-10-05");
    const second = await run("2026-10-06");
    expect(second.summary).toMatchObject({ dm: "already_sent", reports: 2 });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing without an owner or a Slack id", async () => {
    const noOwner = setup({ weekly_report_digest: { ...digest, owner_id: null, slack_user_id: null, owner_email: null } });
    expect((await noOwner.run()).summary).toMatchObject({ dm: "no_owner" });
    const noSlack = setup({ weekly_report_digest: { ...digest, slack_user_id: null } });
    expect((await noSlack.run()).summary).toMatchObject({ dm: "no_slack_user" });
    for (const s of [noOwner, noSlack]) {
      expect(s.sent).toHaveLength(0);
      expect(s.calls.map((c) => c.fn)).not.toContain("weekly_report_claim");
    }
  });
});
