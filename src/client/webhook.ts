/**
 * Verify Mailtrap-Signature: HMAC-SHA256 hex digest of the raw request body.
 * Uses Web Crypto so it works in the Convex runtime (no Node `crypto`).
 *
 * @see https://docs.mailtrap.io/email-api-smtp/advanced/webhooks#verifying-the-signature
 */

export const SIGNATURE_HEX_LENGTH = 64;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function bufferToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns true if `signature` is a valid HMAC-SHA256 hex digest of `payload`
 * under `signingSecret`. Never throws on wire-plausible bad inputs.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  signingSecret: string,
): Promise<boolean> {
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (typeof signingSecret !== "string" || signingSecret.length === 0) {
    return false;
  }
  if (typeof payload !== "string" || payload.length === 0) return false;
  if (signature.length !== SIGNATURE_HEX_LENGTH) return false;
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const expected = bufferToHex(mac);
  return timingSafeEqualHex(expected.toLowerCase(), signature.toLowerCase());
}

/**
 * Verify and parse a Mailtrap webhook body into an events array.
 * Supports JSON `{ events: [...] }` and JSON Lines (one event per line).
 */
export async function verifyAndParseWebhook(
  signingSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<unknown[]> {
  if (!signingSecret) {
    throw new WebhookVerificationError("Webhook secret is empty; cannot verify");
  }
  if (!signatureHeader) {
    throw new WebhookVerificationError("Missing Mailtrap-Signature header");
  }
  const ok = await verifyWebhookSignature(
    rawBody,
    signatureHeader,
    signingSecret,
  );
  if (!ok) {
    throw new WebhookVerificationError("Invalid Mailtrap-Signature");
  }

  const trimmed = rawBody.trim();
  if (!trimmed) return [];

  // JSON Lines: multiple JSON values separated by newlines
  if (trimmed.includes("\n")) {
    const events: unknown[] = [];
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      events.push(JSON.parse(l));
    }
    return events;
  }

  // JSON object with events array, or a single event object
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { events?: unknown[] };
    if (Array.isArray(parsed.events)) return parsed.events;
    if ("event" in parsed || "event_id" in parsed) return [parsed];
    return [];
  }

  return [];
}
