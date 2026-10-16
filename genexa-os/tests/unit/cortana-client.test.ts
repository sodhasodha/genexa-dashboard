import { describe, expect, it } from "vitest";
import { createCortanaClient } from "@/lib/integrations/cortana/client";

const ok = () => new Response(JSON.stringify({ data: [{ id: "b1", name: "Clinic" }] }), { status: 200, headers: { "content-type": "application/json" } });

describe("Cortana client", () => {
  it("tries again after a dropped connection or a server error, then succeeds", async () => {
    const answers: (() => Response)[] = [
      () => { throw new TypeError("fetch failed"); },
      () => new Response("bad gateway", { status: 502 }),
      ok,
    ];
    let calls = 0;
    const c = createCortanaClient({ apiKey: "k", minGapMs: 0, retryDelayMs: 1, fetchImpl: (async () => answers[calls++]()) as typeof fetch });
    expect(await c.businesses()).toEqual([{ id: "b1", name: "Clinic" }]);
    expect(calls).toBe(3);
  });

  it("gives up after four tries, and never retries a request Cortana refused", async () => {
    let calls = 0;
    const down = createCortanaClient({ apiKey: "k", minGapMs: 0, retryDelayMs: 1, fetchImpl: (async () => { calls++; throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(down.businesses()).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(4);
    let refused = 0;
    const bad = createCortanaClient({ apiKey: "k", minGapMs: 0, retryDelayMs: 1, fetchImpl: (async () => { refused++; return new Response("nope", { status: 400 }); }) as typeof fetch });
    await expect(bad.businesses()).rejects.toThrow(/Cortana 400/);
    expect(refused).toBe(1);
  });
});
