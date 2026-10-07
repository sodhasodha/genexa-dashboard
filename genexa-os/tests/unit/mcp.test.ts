import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { McpDbError, MCP_FUNCTIONS, supabaseData, type McpData, type McpFunction } from "@/lib/mcp/data";
import { authorised, handleMcpPost, methodNotAllowed } from "@/lib/mcp/http";
import { handleBody, RPC, type RpcResponse } from "@/lib/mcp/server";
import { TOOLS } from "@/lib/mcp/tools";

const TOKEN = "test-token-0123456789";
const TODAY = "2026-10-07"; // a Wednesday

/** A data layer that records what it was asked and answers from a table. */
function fakeData(answers: Partial<Record<McpFunction, unknown | ((args: Record<string, unknown>) => unknown)>> = {}) {
  const calls: { fn: McpFunction; args: Record<string, unknown> }[] = [];
  const data: McpData = {
    async call(fn, args = {}) {
      calls.push({ fn, args });
      const answer = answers[fn];
      return typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : (answer ?? null);
    },
  };
  return { data, calls };
}

function post(body: unknown, opts: { token?: string | null; data?: McpData; raw?: string; configured?: string | undefined } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  let built = 0;
  const response = handleMcpPost(
    new Request("https://os.example.test/api/mcp", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }),
    {
      token: "configured" in opts ? opts.configured : TOKEN,
      data: () => { built += 1; return opts.data ?? fakeData().data; },
      today: () => TODAY,
    },
  );
  return response.then((r) => ({ r, built: () => built }));
}
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, id: number | string = 1) => rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, id);
type Result = { content: { type: string; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
const resultOf = (res: RpcResponse | RpcResponse[] | null) => (res as { result: Result }).result;
const errorOf = (res: RpcResponse | RpcResponse[] | null) => (res as { error: { code: number; message: string } }).error;
const ctx = (data: McpData) => ({ data, today: TODAY });

describe("auth", () => {
  it("refuses a missing, wrong or malformed token with 401 and never touches the database", async () => {
    for (const token of [null, "wrong-token-0123456789", TOKEN.slice(0, -1), `${TOKEN}x`, ""]) {
      const { r, built } = await post(rpc("tools/list"), { token });
      expect(r.status, String(token)).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
      expect(await r.json()).toEqual({ error: "unauthorised" });
      expect(built()).toBe(0);
    }
    expect(authorised(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(authorised(TOKEN, TOKEN)).toBe(false);
    expect(authorised(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("refuses everything when MCP_BEARER_TOKEN is not set", async () => {
    for (const token of ["", "undefined", TOKEN]) {
      const { r } = await post(rpc("ping"), { token, configured: undefined });
      expect(r.status).toBe(401);
    }
    expect((await post(rpc("ping"), { token: "", configured: "" })).r.status).toBe(401);
  });

  it("lets the right token through", async () => {
    const { r } = await post(rpc("ping"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("HTTP", () => {
  it("GET is 405", async () => {
    const r = methodNotAllowed();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });

  it("a body that is not JSON is a parse error", async () => {
    const { r } = await post(null, { raw: "{not json" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(RPC.PARSE_ERROR);
  });

  it("notifications/initialized is 202 with no body", async () => {
    const { r } = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });
});

describe("JSON-RPC", () => {
  const { data } = fakeData();

  it("initialize echoes a supported protocol version and offers tools", async () => {
    const res = (await handleBody(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), ctx(data))) as { result: Record<string, unknown> };
    expect(res.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "genexa-os" } });
    const newer = (await handleBody(rpc("initialize", { protocolVersion: "2025-06-18" }), ctx(data))) as { result: Record<string, unknown> };
    expect(newer.result.protocolVersion).toBe("2025-06-18");
    const unknown = (await handleBody(rpc("initialize", { protocolVersion: "1999-01-01" }), ctx(data))) as { result: Record<string, unknown> };
    expect(unknown.result.protocolVersion).toBe("2025-03-26");
  });

  it("unknown method is -32601; a malformed message is -32600", async () => {
    expect(errorOf(await handleBody(rpc("resources/list"), ctx(data)))).toMatchObject({ code: RPC.METHOD_NOT_FOUND, message: "Method not found: resources/list" });
    expect(errorOf(await handleBody({ id: 1, method: "ping" }, ctx(data))).code).toBe(RPC.INVALID_REQUEST);
    expect(errorOf(await handleBody("ping", ctx(data))).code).toBe(RPC.INVALID_REQUEST);
    expect(errorOf(await handleBody({ jsonrpc: "2.0", id: {}, method: "ping" }, ctx(data))).code).toBe(RPC.INVALID_REQUEST);
    expect(errorOf(await handleBody([], ctx(data))).code).toBe(RPC.INVALID_REQUEST);
  });

  it("keeps the request id, string or number", async () => {
    expect(await handleBody(rpc("ping", undefined, "abc"), ctx(data))).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
    expect(await handleBody(rpc("ping", undefined, 0), ctx(data))).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
  });

  it("a batch answers each request in order and says nothing for notifications", async () => {
    const res = (await handleBody(
      [rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("nope", undefined, 2), call("get_call_centre", {}, 3), { nonsense: true }],
      ctx(data),
    )) as RpcResponse[];
    expect(res).toHaveLength(4);
    expect(res[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(res[1]).toMatchObject({ id: 2, error: { code: RPC.METHOD_NOT_FOUND } });
    expect(resultOf(res[2]).structuredContent).toEqual({ status: "not_available", reason: "Call centre moves to Hot Prospector — not set up yet." });
    expect(res[3]).toMatchObject({ id: null, error: { code: RPC.INVALID_REQUEST } });
    expect(await handleBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], ctx(data))).toBeNull();
    const http = await post([rpc("ping", undefined, 1), rpc("tools/list", undefined, 2)]);
    expect(http.r.status).toBe(200);
    expect(((await http.r.json()) as unknown[]).length).toBe(2);
  });
});

describe("tools/list", () => {
  const EXPECTED = [
    "get_overview", "get_clients", "get_client", "get_ad_metrics", "get_exceptions", "get_tech_jobs", "get_launches",
    "get_call_centre", "get_scores", "get_eods", "get_tasks", "get_prospects", "get_agency_month", "get_sync_status",
    "write_brief", "add_task", "add_idea", "upsert_prospect", "set_next_action", "log_touch", "set_exception_action",
  ];

  it("lists every tool with a JSON Schema, and no delete tool", async () => {
    const res = (await handleBody(rpc("tools/list"), ctx(fakeData().data))) as { result: { tools: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }[] } };
    const tools = res.result.tools;
    expect(tools.map((t) => t.name)).toEqual(EXPECTED);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema, t.name).toMatchObject({ type: "object", additionalProperties: false });
      expect(typeof t.inputSchema.properties, t.name).toBe("object");
      expect(t.name).not.toMatch(/delete|remove/);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.annotations.readOnlyHint).toBe(t.name.startsWith("get_"));
    }
  });

  it("each JSON Schema names the same arguments, and the same required ones, as its validator", () => {
    for (const t of TOOLS) {
      const shape = (t.args as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      expect(Object.keys(t.inputSchema.properties).sort(), t.name).toEqual(Object.keys(shape).sort());
      const required = Object.keys(shape).filter((k) => !shape[k].safeParse(undefined).success).sort();
      expect([...(t.inputSchema.required ?? [])].sort(), t.name).toEqual(required);
    }
  });

  it("the contact column cannot be asked for or sent", () => {
    const prospect = TOOLS.find((t) => t.name === "upsert_prospect");
    expect(Object.keys(prospect?.inputSchema.properties ?? {})).not.toContain("contact");
    expect(prospect?.args.safeParse({ name: "X", contact: "555" }).success).toBe(false);
  });

  it("every SQL function the tools call is a known mcp_ function", () => {
    expect(MCP_FUNCTIONS.every((f) => f.startsWith("mcp_"))).toBe(true);
    expect(MCP_FUNCTIONS.some((f) => /delete|remove/.test(f))).toBe(false);
  });
});

describe("tools/call", () => {
  it("unknown tool and missing name are -32602", async () => {
    const { data, calls } = fakeData();
    expect(errorOf(await handleBody(call("drop_everything"), ctx(data)))).toEqual({ code: RPC.INVALID_PARAMS, message: "Unknown tool: drop_everything" });
    expect(errorOf(await handleBody(call("delete_task", { id: "x" }), ctx(data))).code).toBe(RPC.INVALID_PARAMS);
    expect(errorOf(await handleBody(rpc("tools/call", {}), ctx(data))).code).toBe(RPC.INVALID_PARAMS);
    expect(errorOf(await handleBody(rpc("tools/call"), ctx(data))).code).toBe(RPC.INVALID_PARAMS);
    expect(calls).toEqual([]);
  });

  it("bad arguments are -32602 with a readable message, and nothing is called", async () => {
    const { data, calls } = fakeData();
    const bad: [string, unknown, RegExp][] = [
      ["get_overview", { period: "yesterday" }, /get_overview: period: /],
      ["get_client", {}, /get_client: id: /],
      ["get_client", { id: "12" }, /id: must be a uuid/],
      ["get_ad_metrics", { client_id: "00000000-0000-0000-0000-000000000001" }, /window: /],
      ["get_exceptions", { status: "closed" }, /status: /],
      ["get_scores", { week: "2026-10-07" }, /week: must be a Monday/],
      ["get_eods", { from: "2026-10-07", to: "2026-10-01" }, /to: must not be before from/],
      ["get_eods", { from: "2026-01-01", to: "2026-10-01" }, /92 days or fewer/],
      ["get_eods", { from: "2026-02-30", to: "2026-03-01" }, /from: must be a date/],
      ["get_agency_month", { month: "2026-13" }, /month: must be a month/],
      ["get_clients", { stage: "live" }, /Unrecognized key/],
      ["write_brief", { date: "2026-10-07", kind: "monthly", markdown: "x" }, /kind: /],
      ["write_brief", { date: "2026-10-07", kind: "daily", markdown: "   " }, /markdown: must not be empty/],
      ["add_task", { owner: "Sameer", title: "x", category: "tech", source: "ryan" }, /source: /],
      ["add_task", { owner: "Sameer", title: "x", category: "admin", source: "claude" }, /category: /],
      ["add_task", { owner: "Sameer", title: "x", category: "tech", source: "claude", due: "tomorrow" }, /due: must be a date/],
      ["add_idea", { text: "x" }, /source: /],
      ["upsert_prospect", { name: "X", contact: "555-0100" }, /Unrecognized key/],
      ["upsert_prospect", { name: "X", heat: "boiling" }, /heat: /],
      ["upsert_prospect", { name: "X", deal_size: "9000" }, /deal_size: /],
      ["log_touch", { client_id: "00000000-0000-0000-0000-000000000001", kind: "sms", note: "x" }, /kind: /],
      ["set_exception_action", { id: "00000000-0000-0000-0000-000000000001" }, /text: /],
      ["get_tasks", "sameer", /arguments must be an object/],
    ];
    for (const [name, args, message] of bad) {
      const error = errorOf(await handleBody(call(name, args), ctx(data)));
      expect(error.code, `${name} ${JSON.stringify(args)}`).toBe(RPC.INVALID_PARAMS);
      expect(error.message, `${name} ${JSON.stringify(args)}`).toMatch(message);
      expect(error.message).toContain(`Invalid arguments for ${name}`);
    }
    expect(calls).toEqual([]);
  });

  it("returns the result as text and as structuredContent, the same object", async () => {
    const rows = [{ id: "c1", name: "Alpha", fee: null }];
    const { data, calls } = fakeData({ mcp_get_clients: rows });
    const result = resultOf(await handleBody(call("get_clients"), ctx(data)));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ clients: rows });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ clients: rows }) }]);
    expect(calls).toEqual([{ fn: "mcp_get_clients", args: {} }]);
  });

  it("get_overview resolves the period and the one before it from today", async () => {
    const { data, calls } = fakeData({ mcp_get_overview: { current: { leads: 4, expenses: null }, previous: { leads: 2, expenses: null } } });
    const week = resultOf(await handleBody(call("get_overview", { period: "week" }), ctx(data))).structuredContent;
    expect(calls[0]).toEqual({ fn: "mcp_get_overview", args: { p_from: "2026-10-05", p_to: "2026-10-07", p_prev_from: "2026-09-28", p_prev_to: "2026-09-30" } });
    expect(week).toMatchObject({ period: { key: "week", previous_label: "same days last week" }, current: { leads: 4, expenses: null } });
    await handleBody(call("get_overview"), ctx(data));
    expect(calls[1].args).toEqual({ p_from: "2026-10-01", p_to: "2026-10-07", p_prev_from: "2026-09-01", p_prev_to: "2026-09-07" });
    await handleBody(call("get_overview", { period: "last_month" }), ctx(data));
    expect(calls[2].args).toMatchObject({ p_from: "2026-09-01", p_to: "2026-09-30" });
  });

  it("passes each tool's arguments to its SQL function", async () => {
    const C = "00000000-0000-0000-0000-00000000000a";
    const cases: [string, Record<string, unknown>, McpFunction, Record<string, unknown>][] = [
      ["get_client", { id: C }, "mcp_get_client", { p_client_id: C }],
      ["get_ad_metrics", { client_id: C, window: "3d" }, "mcp_get_ad_metrics", { p_client_id: C, p_days: 3 }],
      ["get_ad_metrics", { client_id: C, window: "7d" }, "mcp_get_ad_metrics", { p_client_id: C, p_days: 7 }],
      ["get_ad_metrics", { client_id: C, window: "all" }, "mcp_get_ad_metrics", { p_client_id: C, p_days: undefined }],
      ["get_exceptions", {}, "mcp_get_exceptions", { p_status: "open" }],
      ["get_exceptions", { status: "snoozed" }, "mcp_get_exceptions", { p_status: "snoozed" }],
      ["get_tech_jobs", { status: "stuck" }, "mcp_get_tech_jobs", { p_status: "stuck" }],
      ["get_launches", {}, "mcp_get_launches", {}],
      ["get_scores", { week: "2026-10-05" }, "mcp_get_scores", { p_week: "2026-10-05" }],
      ["get_eods", { from: "2026-10-01", to: "2026-10-07" }, "mcp_get_eods", { p_from: "2026-10-01", p_to: "2026-10-07" }],
      ["get_tasks", { owner: " Amanda " }, "mcp_get_tasks", { p_owner: "Amanda" }],
      ["get_prospects", {}, "mcp_get_prospects", {}],
      ["get_agency_month", { month: "2026-09" }, "mcp_get_agency_month", { p_month: "2026-09-01" }],
      ["get_sync_status", {}, "mcp_get_sync_status", {}],
      ["write_brief", { date: "2026-10-07", kind: "daily", markdown: "# Hi" }, "mcp_write_brief", { p_date: "2026-10-07", p_kind: "daily", p_markdown: "# Hi" }],
      ["add_idea", { text: "An idea", source: "slack" }, "mcp_add_idea", { p_text: "An idea", p_source: "slack" }],
      ["upsert_prospect", { name: "Smith", heat: "hot", deal_size: 9000 }, "mcp_upsert_prospect", { p_name: "Smith", p_fields: { heat: "hot", deal_size: 9000 } }],
      ["set_next_action", { client_id: C, text: "Call" }, "mcp_set_next_action", { p_client_id: C, p_text: "Call" }],
      ["log_touch", { client_id: C, kind: "slack", note: "Pinged" }, "mcp_log_touch", { p_client_id: C, p_kind: "slack", p_note: "Pinged" }],
      ["set_exception_action", { id: C, text: "Done" }, "mcp_set_exception_action", { p_id: C, p_text: "Done" }],
    ];
    for (const [name, args, fn, expected] of cases) {
      const { data, calls } = fakeData();
      const result = resultOf(await handleBody(call(name, args), ctx(data)));
      expect(result.isError, name).toBeUndefined();
      expect(calls, name).toEqual([{ fn, args: expected }]);
    }
  });

  it("get_call_centre never reaches the database", async () => {
    const { data, calls } = fakeData();
    const result = resultOf(await handleBody(call("get_call_centre", { window: "7d" }), ctx(data)));
    expect(result.structuredContent).toEqual({ status: "not_available", reason: "Call centre moves to Hot Prospector — not set up yet." });
    expect(calls).toEqual([]);
  });

  it("get_agency_month refuses a month that has not started", async () => {
    const { data, calls } = fakeData();
    const result = resultOf(await handleBody(call("get_agency_month", { month: "2026-11" }), ctx(data)));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID" } });
    expect(calls).toEqual([]);
  });

  describe("add_task rules, checked in the endpoint before anything is written", () => {
    const owner = (role: string, name: string) => ({ id: "00000000-0000-0000-0000-0000000000aa", name, role });
    const base = { title: "Do the thing", category: "general", source: "claude" };

    it("Ryan's list: only source = pushpin", async () => {
      const { data, calls } = fakeData({ mcp_task_check: { owner: owner("owner", "Ryan"), deleted_match: null }, mcp_add_task: { id: "t1" } });
      for (const source of ["claude", "call", "slack", "system"]) {
        const result = resultOf(await handleBody(call("add_task", { ...base, owner: "Ryan", source }), ctx(data)));
        expect(result.isError, source).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "TASK_OWNER_LIST", enforced_by: "endpoint", rule: "Ryan's list only accepts tasks with source = pushpin." } });
      }
      expect(calls.some((c) => c.fn === "mcp_add_task")).toBe(false);
      const ok = resultOf(await handleBody(call("add_task", { ...base, owner: "Ryan", source: "pushpin" }), ctx(data)));
      expect(ok.isError).toBeUndefined();
      expect(calls.at(-1)).toMatchObject({ fn: "mcp_add_task", args: { p_owner: "00000000-0000-0000-0000-0000000000aa", p_source: "pushpin", p_title: "Do the thing" } });
    });

    it("media buyer: only ads or call_centre", async () => {
      const { data, calls } = fakeData({ mcp_task_check: { owner: owner("media_buyer", "Aditya"), deleted_match: null }, mcp_add_task: { id: "t1" } });
      for (const category of ["tech", "general"]) {
        const result = resultOf(await handleBody(call("add_task", { ...base, owner: "Aditya", category }), ctx(data)));
        expect(result.structuredContent).toMatchObject({ error: { code: "TASK_CATEGORY", enforced_by: "endpoint" } });
      }
      expect(calls.some((c) => c.fn === "mcp_add_task")).toBe(false);
      for (const category of ["ads", "call_centre"]) {
        expect(resultOf(await handleBody(call("add_task", { ...base, owner: "Aditya", category }), ctx(data))).isError).toBeUndefined();
      }
    });

    it("a title matching a deleted task is refused, with the match", async () => {
      const { data, calls } = fakeData({ mcp_task_check: { owner: owner("tech", "Sameer"), deleted_match: { title: "Do the thing!", similarity: 0.82 } } });
      const result = resultOf(await handleBody(call("add_task", { ...base, owner: "Sameer" }), ctx(data)));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "TASK_DELETED_MATCH", enforced_by: "endpoint", matched: { title: "Do the thing!", similarity: 0.82 } } });
      expect(calls.map((c) => c.fn)).toEqual(["mcp_task_check"]);
    });
  });

  it("a database refusal is a tool error with its code, not a protocol error", async () => {
    const failing = (message: string): McpData => ({ call: async () => { throw new McpDbError(message, "P0001"); } });
    const C = "00000000-0000-0000-0000-00000000000a";
    const cases: [string, Record<string, unknown>][] = [
      ["TASK_OWNER_LIST: only Ryan can add to Ryan's list", { code: "TASK_OWNER_LIST", enforced_by: "database", message: "only Ryan can add to Ryan's list" }],
      ["TASK_CATEGORY: media buyer tasks must be ads or call_centre", { code: "TASK_CATEGORY", enforced_by: "database" }],
      ["TASK_DELETED_MATCH: matches a task this owner deleted", { code: "TASK_DELETED_MATCH", enforced_by: "database" }],
      [`MCP_NOT_FOUND: no client with id ${C}`, { code: "NOT_FOUND", message: `no client with id ${C}` }],
      ['MCP_AMBIGUOUS: more than one staff member matches "Amanda"', { code: "AMBIGUOUS" }],
      ["connection refused", { code: "DATABASE_ERROR", message: "connection refused" }],
    ];
    for (const [message, expected] of cases) {
      const res = await handleBody(call("set_next_action", { client_id: C, text: "x" }), ctx(failing(message)));
      expect(res).not.toHaveProperty("error");
      const result = resultOf(res);
      expect(result.isError, message).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: expected });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    }
    const crash: McpData = { call: async () => { throw new TypeError("boom"); } };
    expect(resultOf(await handleBody(call("get_clients"), ctx(crash))).structuredContent).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "boom" } });
  });
});

describe("supabaseData", () => {
  it("calls rpc with the defined arguments and turns an error into McpDbError", async () => {
    const seen: unknown[] = [];
    const client = {
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        seen.push([fn, args]);
        return fn === "mcp_add_idea" ? { data: null, error: { message: "MCP_INVALID: text is required", code: "P0001" } } : { data: [{ ok: true }], error: null };
      },
    };
    const data = supabaseData(client);
    expect(await data.call("mcp_get_tech_jobs", { p_status: undefined })).toEqual([{ ok: true }]);
    expect(seen[0]).toEqual(["mcp_get_tech_jobs", {}]);
    await expect(data.call("mcp_add_idea", { p_text: "", p_source: "x" })).rejects.toThrow(McpDbError);
  });
});
