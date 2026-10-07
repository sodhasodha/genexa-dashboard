import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" };

const MAX_AGE_SECONDS = 5 * 60;

/**
 * Slack request signing, version v0: HMAC-SHA256 of "v0:{timestamp}:{raw body}"
 * with the app's signing secret. A request older than 5 minutes is refused, so a
 * captured one cannot be replayed.
 */
export function verifySlackSignature(input: {
  secret: string | undefined;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
}): SignatureCheck {
  const { secret, timestamp, signature, body } = input;
  if (!secret || !timestamp || !signature) return { ok: false, reason: "missing" };
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "missing" };
  const nowSeconds = (input.now ?? new Date()).getTime() / 1000;
  if (Math.abs(nowSeconds - sentAt) > MAX_AGE_SECONDS) return { ok: false, reason: "stale" };

  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** The signature Slack would send. Used by tests. */
export function signSlackRequest(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}
