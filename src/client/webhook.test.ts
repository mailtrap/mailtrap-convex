import { describe, expect, it } from "vitest";
import {
  SIGNATURE_HEX_LENGTH,
  verifyAndParseWebhook,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "./webhook.js";

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid HMAC-SHA256 hex digest", async () => {
    const secret = "a".repeat(32);
    const body = JSON.stringify({ events: [{ event: "delivery" }] });
    const sig = await sign(secret, body);
    expect(sig).toHaveLength(SIGNATURE_HEX_LENGTH);
    expect(await verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const secret = "a".repeat(32);
    const body = '{"events":[]}';
    expect(
      await verifyWebhookSignature(body, "0".repeat(64), secret),
    ).toBe(false);
  });

  it("rejects empty inputs", async () => {
    expect(await verifyWebhookSignature("", "0".repeat(64), "secret")).toBe(
      false,
    );
    expect(await verifyWebhookSignature("body", "", "secret")).toBe(false);
    expect(await verifyWebhookSignature("body", "0".repeat(64), "")).toBe(
      false,
    );
  });
});

describe("verifyAndParseWebhook", () => {
  it("parses JSON events array", async () => {
    const secret = "b".repeat(32);
    const body = JSON.stringify({
      events: [
        { event: "delivery", event_id: "e1", message_id: "m1" },
        { event: "open", event_id: "e2", message_id: "m1" },
      ],
    });
    const sig = await sign(secret, body);
    const events = await verifyAndParseWebhook(secret, body, sig);
    expect(events).toHaveLength(2);
  });

  it("parses JSON Lines", async () => {
    const secret = "c".repeat(32);
    const body =
      '{"event":"delivery","event_id":"e1"}\n{"event":"bounce","event_id":"e2"}\n';
    const sig = await sign(secret, body);
    const events = await verifyAndParseWebhook(secret, body, sig);
    expect(events).toHaveLength(2);
  });

  it("throws on bad signature", async () => {
    await expect(
      verifyAndParseWebhook("secret", '{"events":[]}', "0".repeat(64)),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});
