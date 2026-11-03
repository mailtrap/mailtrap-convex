import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { api } from "./_generated/api.js";
import workpoolTest from "@convex-dev/workpool/test";

const modules = import.meta.glob("./**/*.ts");

const config = {
  retryAttempts: 2,
  initialBackoffMs: 50,
  sandbox: false as const,
};

function setupTest() {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, "sendPool");
  workpoolTest.register(t, "callbackPool");
  return t;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;
let originalToken: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as typeof fetch;
  originalToken = process.env.MAILTRAP_API_TOKEN;
  process.env.MAILTRAP_API_TOKEN = "test-token";
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.MAILTRAP_API_TOKEN;
  else process.env.MAILTRAP_API_TOKEN = originalToken;
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("enqueueSend", () => {
  it("inserts an outboundEmails row in pending status", async () => {
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    expect(id).toBeTruthy();
    const status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("pending");
  });

  it("transitions to sent on success", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message_ids: ["mt-1"] }));
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("sent");
    expect(status?.mailtrapMessageId).toBe("mt-1");
  });

  it("marks failed on permanent 4xx", async () => {
    fetchSpy.mockResolvedValue(
      new Response("bad", { status: 400, headers: { "content-type": "text/plain" } }),
    );
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    // Call the send action directly to avoid workpool timer flakiness across tests.
    const { internal } = await import("./_generated/api.js");
    await t.action(internal.lib.performSend, { outboundId: id });
    const status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("failed");
  });

  it("cancels while pending", async () => {
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    await t.mutation(api.lib.cancelEmail, { emailId: id });
    const status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("cancelled");
  });
});

describe("enqueueBatch", () => {
  it("sends via /api/batch and assigns message ids", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        message_ids: ["b1", "b2"],
      }),
    );
    const t = setupTest();
    const result = await t.mutation(api.lib.enqueueBatch, {
      config,
      stream: "bulk",
      base: {
        from: { email: "from@example.com" },
        subject: "Batch",
        text: "Hi",
      },
      requests: [
        { to: [{ email: "a@example.com" }] },
        { to: [{ email: "b@example.com" }] },
      ],
    });
    expect(result.emailIds).toHaveLength(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const s0 = await t.query(api.lib.getOutboundStatus, {
      emailId: result.emailIds[0]!,
    });
    const s1 = await t.query(api.lib.getOutboundStatus, {
      emailId: result.emailIds[1]!,
    });
    expect(s0?.status).toBe("sent");
    expect(s0?.mailtrapMessageId).toBe("b1");
    expect(s1?.mailtrapMessageId).toBe("b2");
  });
});

describe("handleEvents", () => {
  it("updates delivery status and ignores duplicate event_id", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message_ids: ["mt-1"] }));
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.mutation(api.lib.handleEvents, {
      config,
      events: [
        {
          event: "delivery",
          event_id: "evt-1",
          message_id: "mt-1",
          email: "to@example.com",
          sending_stream: "transactional",
          timestamp: 1,
        },
      ],
    });
    let status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("delivered");

    await t.mutation(api.lib.handleEvents, {
      config,
      events: [
        {
          event: "bounce",
          event_id: "evt-1",
          message_id: "mt-1",
          email: "to@example.com",
          sending_stream: "transactional",
          timestamp: 2,
        },
      ],
    });
    status = await t.query(api.lib.getOutboundStatus, { emailId: id });
    expect(status?.status).toBe("delivered");
  });

  it("fetches and stores inbound messages", async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages/")) {
        return jsonResponse({
          id: "1866",
          inbox_id: 15,
          from: "Jane <jane@example.com>",
          to: ["demo@inbound-mailtrap.io"],
          subject: "Hello",
          text: "Hi there",
          thread_id: "thread-1",
          headers: {},
          attachments: [],
          received_at: "2026-06-02T08:17:31.878Z",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const t = setupTest();
    await t.mutation(api.lib.handleEvents, {
      config,
      events: [
        {
          event: "inbound.message_received",
          event_id: "in-1",
          inbox_id: 15,
          message_id: "1866",
          from: "Jane <jane@example.com>",
          timestamp: 1,
        },
      ],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.query(api.lib.listInboundMessages, {
      inboxId: 15,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("Hello");
    expect(messages[0]?.threadId).toBe("thread-1");
  });
});

describe("cleanupFinalizedOutbound", () => {
  it("deletes old finalized rows", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message_ids: ["mt-clean"] }));
    const t = setupTest();
    const id = await t.mutation(api.lib.enqueueSend, {
      config,
      stream: "transactional",
      payload: {
        from: { email: "from@example.com" },
        to: [{ email: "to@example.com" }],
        subject: "hi",
        text: "hello",
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(id);
      expect(row).toBeTruthy();
      await ctx.db.patch(id, { finalizedAt: 1 });
    });

    const result = await t.mutation(api.lib.cleanupFinalizedOutbound, {
      olderThan: 100,
    });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await t.query(api.lib.getOutboundStatus, { emailId: id })).toBeNull();
  });
});
