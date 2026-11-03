import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { api, components, internal } from "./_generated/api.js";
import type { ComponentApi } from "./_generated/component.js";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionHandle, FunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import {
  mapSendingEventToStatus,
  shouldUpgradeStatus,
  vEmailPayload,
  vBatchRequest,
  vInboundReplyPayload,
  vRuntimeConfig,
  vStream,
  type OutboundStatus,
  type RuntimeConfig,
} from "./shared.js";
import {
  extractMessageIds,
  inboundFetch,
  MailtrapApiError,
  parseTimestamp,
  sendBatchApi,
  sendEmailApi,
} from "./utils.js";

const FINALIZED_OUTBOUND_RETENTION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SEND_POOL_PARALLELISM = 8;
const CALLBACK_POOL_PARALLELISM = 8;

const sendPool = new Workpool(components.sendPool, {
  maxParallelism: SEND_POOL_PARALLELISM,
});

const callbackPool = new Workpool(components.callbackPool, {
  maxParallelism: CALLBACK_POOL_PARALLELISM,
});

// ---------------------------------------------------------------------------
// Sending: enqueue → workpool → performSend / performBatch
// ---------------------------------------------------------------------------

export const enqueueSend = mutation({
  args: {
    config: vRuntimeConfig,
    stream: vStream,
    payload: vEmailPayload,
  },
  handler: async (ctx, args) => {
    if (args.config.sandbox && args.config.testInboxId == null) {
      throw new Error(
        "sandbox mode requires testInboxId (set MAILTRAP_TEST_INBOX_ID or pass testInboxId in options)",
      );
    }
    if (!args.payload.to || args.payload.to.length === 0) {
      throw new Error("to is required for sendEmail");
    }
    if (!args.payload.template_uuid) {
      if (!args.payload.subject) {
        throw new Error("subject is required unless template_uuid is set");
      }
      if (!args.payload.text && !args.payload.html) {
        throw new Error("text or html is required unless template_uuid is set");
      }
    }

    const id = await ctx.db.insert("outboundEmails", {
      stream: args.stream,
      sandbox: args.config.sandbox,
      testInboxId: args.config.testInboxId,
      payload: args.payload,
      status: "pending",
    });

    await sendPool.enqueueAction(
      ctx,
      internal.lib.performSend,
      { outboundId: id },
      {
        retry: {
          maxAttempts: args.config.retryAttempts,
          initialBackoffMs: args.config.initialBackoffMs,
          base: 2,
        },
        context: { outboundId: id },
        onComplete: internal.lib.onSendComplete,
      },
    );
    return id;
  },
});

export const enqueueBatch = mutation({
  args: {
    config: vRuntimeConfig,
    stream: vStream,
    base: vEmailPayload,
    requests: v.array(vBatchRequest),
  },
  handler: async (ctx, args) => {
    if (args.config.sandbox && args.config.testInboxId == null) {
      throw new Error(
        "sandbox mode requires testInboxId (set MAILTRAP_TEST_INBOX_ID or pass testInboxId in options)",
      );
    }
    if (args.requests.length === 0) {
      throw new Error("requests must not be empty");
    }
    if (args.requests.length > 500) {
      throw new Error("Mailtrap batch accepts at most 500 requests");
    }

    const emailIds = [];
    for (let i = 0; i < args.requests.length; i++) {
      const req = args.requests[i]!;
      const merged = { ...args.base, ...req };
      const id = await ctx.db.insert("outboundEmails", {
        stream: args.stream,
        sandbox: args.config.sandbox,
        testInboxId: args.config.testInboxId,
        payload: merged,
        status: "pending",
        batchIndex: i,
      });
      emailIds.push(id);
    }

    const batchId = await ctx.db.insert("outboundBatches", {
      stream: args.stream,
      sandbox: args.config.sandbox,
      testInboxId: args.config.testInboxId,
      base: args.base,
      status: "pending",
      emailIds,
    });

    for (const emailId of emailIds) {
      await ctx.db.patch(emailId, { batchId });
    }

    await sendPool.enqueueAction(
      ctx,
      internal.lib.performBatch,
      { batchId },
      {
        retry: {
          maxAttempts: args.config.retryAttempts,
          initialBackoffMs: args.config.initialBackoffMs,
          base: 2,
        },
        context: { batchId },
        onComplete: internal.lib.onBatchComplete,
      },
    );

    return { batchId, emailIds };
  },
});

export const cancelEmail = mutation({
  args: { emailId: v.id("outboundEmails") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.emailId);
    if (!row) throw new Error("Outbound email not found");
    if (row.status !== "pending" && row.status !== "queued") {
      throw new Error(`Cannot cancel: status is ${row.status}`);
    }
    await ctx.db.patch(args.emailId, {
      status: "cancelled",
      errorMessage: "Cancelled by user",
      finalizedAt: Date.now(),
    });
  },
});

export const getOutboundForSend = internalQuery({
  args: { outboundId: v.id("outboundEmails") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboundId);
    if (!row) return null;
    if (row.status === "cancelled" || row.status === "failed") return null;
    return row;
  },
});

export const getBatchForSend = internalQuery({
  args: { batchId: v.id("outboundBatches") },
  handler: async (ctx, args) => {
    const batch = await ctx.db.get(args.batchId);
    if (!batch) return null;
    if (batch.status === "cancelled" || batch.status === "failed") return null;
    const emails = [];
    for (const id of batch.emailIds) {
      const row = await ctx.db.get(id);
      if (row && row.status !== "cancelled") emails.push(row);
    }
    return { batch, emails };
  },
});

export const performSend = internalAction({
  args: { outboundId: v.id("outboundEmails") },
  returns: v.union(
    v.null(),
    v.object({ mailtrapMessageId: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.lib.getOutboundForSend, {
      outboundId: args.outboundId,
    });
    if (!row) return null;

    try {
      const response = await sendEmailApi({
        stream: row.stream,
        sandbox: row.sandbox,
        testInboxId: row.testInboxId,
        payload: row.payload,
      });
      const ids = extractMessageIds(response);
      if (ids.length === 0) {
        await ctx.runMutation(api.lib.markSendFailed, {
          outboundId: args.outboundId,
          errorMessage: "Mailtrap returned 2xx without message_id(s)",
        });
        return null;
      }
      return { mailtrapMessageId: ids[0]! };
    } catch (err) {
      if (isPermanentMailtrapError(err)) {
        const e = err as MailtrapApiError;
        await ctx.runMutation(api.lib.markSendFailed, {
          outboundId: args.outboundId,
          errorMessage: `${e.message}: ${e.body}`,
        });
        return null;
      }
      throw err;
    }
  },
});

function isPermanentMailtrapError(err: unknown): err is MailtrapApiError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as MailtrapApiError).name === "MailtrapApiError" &&
    (err as MailtrapApiError).permanent === true
  );
}

export const performBatch = internalAction({
  args: { batchId: v.id("outboundBatches") },
  returns: v.union(
    v.null(),
    v.object({
      messageIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.lib.getBatchForSend, {
      batchId: args.batchId,
    });
    if (!data) return null;
    const { batch, emails } = data;
    if (emails.length === 0) return null;

    const requests = emails.map((e) => {
      const p = e.payload as Record<string, unknown>;
      // Per-request overrides: omit fields already in base when identical is fine —
      // Mailtrap merges base + request; we store merged payload, so send only the
      // request-specific slice by re-deriving from stored full payload minus base keys
      // that match. Simpler: send each merged payload as a full request with empty base.
      return p;
    });

    try {
      const response = await sendBatchApi({
        stream: batch.stream,
        sandbox: batch.sandbox,
        testInboxId: batch.testInboxId,
        base: {},
        requests,
      });
      const ids = extractMessageIds(response);
      return { messageIds: ids };
    } catch (err) {
      if (isPermanentMailtrapError(err)) {
        const e = err as MailtrapApiError;
        await ctx.runMutation(api.lib.markBatchFailed, {
          batchId: args.batchId,
          errorMessage: `${e.message}: ${e.body}`,
        });
        return null;
      }
      throw err;
    }
  },
});

export const onSendComplete = sendPool.defineOnComplete({
  context: v.object({ outboundId: v.id("outboundEmails") }),
  handler: async (ctx, args) => {
    const { outboundId } = args.context;
    const row = await ctx.db.get(outboundId);
    if (!row) return;

    if (args.result.kind === "success") {
      const value = args.result.returnValue as {
        mailtrapMessageId: string;
      } | null;
      if (value === null) return;
      if (row.status === "cancelled" || row.status === "failed") return;
      await ctx.db.patch(outboundId, {
        status: "sent",
        mailtrapMessageId: value.mailtrapMessageId,
        finalizedAt: Date.now(),
      });
    } else if (args.result.kind === "failed") {
      if (row.status === "cancelled") return;
      await ctx.db.patch(outboundId, {
        status: "failed",
        errorMessage: args.result.error,
        finalizedAt: Date.now(),
      });
    } else if (args.result.kind === "canceled") {
      if (row.status === "cancelled" || row.status === "failed") return;
      await ctx.db.patch(outboundId, {
        status: "cancelled",
        errorMessage: "Workpool cancelled the send",
        finalizedAt: Date.now(),
      });
    }
  },
});

export const onBatchComplete = sendPool.defineOnComplete({
  context: v.object({ batchId: v.id("outboundBatches") }),
  handler: async (ctx, args) => {
    const { batchId } = args.context;
    const batch = await ctx.db.get(batchId);
    if (!batch) return;

    if (args.result.kind === "success") {
      const value = args.result.returnValue as {
        messageIds: string[];
      } | null;
      if (value === null) return;
      if (batch.status === "cancelled" || batch.status === "failed") return;

      const now = Date.now();
      const emailIds = batch.emailIds as Id<"outboundEmails">[];
      for (let i = 0; i < emailIds.length; i++) {
        const emailId = emailIds[i]!;
        const row = await ctx.db.get(emailId);
        if (!row || row.status === "cancelled") continue;
        const messageId = value.messageIds[i];
        await ctx.db.patch(emailId, {
          status: messageId ? "sent" : "failed",
          mailtrapMessageId: messageId,
          errorMessage: messageId
            ? undefined
            : "No message_id in batch response for this index",
          finalizedAt: now,
        });
      }
      await ctx.db.patch(batchId, {
        status: "sent",
        finalizedAt: now,
      });
    } else if (args.result.kind === "failed") {
      await ctx.runMutation(api.lib.markBatchFailed, {
        batchId,
        errorMessage: args.result.error,
      });
    } else if (args.result.kind === "canceled") {
      if (batch.status === "cancelled" || batch.status === "failed") return;
      await ctx.db.patch(batchId, {
        status: "cancelled",
        errorMessage: "Workpool cancelled the batch",
        finalizedAt: Date.now(),
      });
    }
  },
});

export const markSendFailed = mutation({
  args: {
    outboundId: v.id("outboundEmails"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboundId);
    if (!row || row.status === "cancelled") return;
    await ctx.db.patch(args.outboundId, {
      status: "failed",
      errorMessage: args.errorMessage,
      finalizedAt: Date.now(),
    });
  },
});

export const markBatchFailed = mutation({
  args: {
    batchId: v.id("outboundBatches"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db.get(args.batchId);
    if (!batch) return;
    const now = Date.now();
    await ctx.db.patch(args.batchId, {
      status: "failed",
      errorMessage: args.errorMessage,
      finalizedAt: now,
    });
    const emailIds = batch.emailIds as Id<"outboundEmails">[];
    for (const emailId of emailIds) {
      const row = await ctx.db.get(emailId);
      if (!row || row.status === "cancelled") continue;
      await ctx.db.patch(emailId, {
        status: "failed",
        errorMessage: args.errorMessage,
        finalizedAt: now,
      });
    }
  },
});

export const getOutboundStatus = query({
  args: { emailId: v.id("outboundEmails") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.emailId);
    if (!row) return null;
    return {
      status: row.status,
      mailtrapMessageId: row.mailtrapMessageId ?? null,
      errorMessage: row.errorMessage ?? null,
      opened: row.opened ?? false,
      clicked: row.clicked ?? false,
      stream: row.stream,
      sandbox: row.sandbox,
    };
  },
});

export const getOutboundEmail = query({
  args: { emailId: v.id("outboundEmails") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.emailId);
  },
});

export const cleanupFinalizedOutbound = mutation({
  args: { olderThan: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff =
      Date.now() - (args.olderThan ?? FINALIZED_OUTBOUND_RETENTION_MS);
    const rows = await ctx.db
      .query("outboundEmails")
      .withIndex("by_finalizedAt", (q) => q.lt("finalizedAt", cutoff))
      .take(100);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length };
  },
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const handleEvents = mutation({
  args: {
    config: vRuntimeConfig,
    events: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    for (const raw of args.events) {
      await processOneEvent(ctx, args.config, raw);
    }
  },
});

async function processOneEvent(
  ctx: {
    db: {
      query: any;
      insert: any;
      patch: any;
      get: any;
    };
    scheduler: any;
    runMutation?: any;
  },
  config: RuntimeConfig,
  raw: any,
) {
  const eventType = String(raw.event ?? raw.event_type ?? "");
  const eventId = String(raw.event_id ?? "");
  if (!eventId) return;

  const existing = await ctx.db
    .query("events")
    .withIndex("by_eventId", (q: any) => q.eq("eventId", eventId))
    .unique();
  if (existing) return;

  if (eventType === "inbound.message_received") {
    const inboxId = Number(raw.inbox_id);
    const messageId = String(raw.message_id ?? "");
    await ctx.db.insert("events", {
      eventId,
      eventType,
      inboxId: Number.isFinite(inboxId) ? inboxId : undefined,
      inboundMessageId: messageId || undefined,
      receivedAt: Date.now(),
      raw,
    });

    // Fetch full message in a background action, then store + callback.
    await sendPool.enqueueAction(
      ctx as any,
      internal.lib.fetchAndStoreInbound,
      {
        config,
        inboxId,
        messageId,
        eventId,
        from: raw.from != null ? String(raw.from) : undefined,
      },
      {
        retry: {
          maxAttempts: config.retryAttempts,
          initialBackoffMs: config.initialBackoffMs,
          base: 2,
        },
      },
    );
    return;
  }

  const status = mapSendingEventToStatus(eventType);
  const mailtrapMessageId =
    typeof raw.message_id === "string" ? raw.message_id : undefined;

  let outboundEmailId = undefined as undefined | string;
  if (mailtrapMessageId) {
    const email = await ctx.db
      .query("outboundEmails")
      .withIndex("by_mailtrapMessageId", (q: any) =>
        q.eq("mailtrapMessageId", mailtrapMessageId),
      )
      .unique();
    if (email) {
      outboundEmailId = email._id;
      const patch: Record<string, unknown> = {};
      if (eventType === "open") patch.opened = true;
      if (eventType === "click") patch.clicked = true;
      if (status && shouldUpgradeStatus(email.status as OutboundStatus, status)) {
        patch.status = status;
        if (
          status === "bounced" ||
          status === "rejected" ||
          status === "suspended" ||
          status === "spam" ||
          status === "delivered"
        ) {
          patch.finalizedAt = Date.now();
        }
        if (raw.reason || raw.response) {
          patch.errorMessage = String(raw.reason ?? raw.response);
        }
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(email._id, patch);
      }
    }
  }

  await ctx.db.insert("events", {
    eventId,
    eventType,
    mailtrapMessageId,
    outboundEmailId,
    receivedAt: Date.now(),
    raw,
  });

  if (config.onEmailEvent?.fnHandle) {
    await callbackPool.enqueueMutation(
      ctx as any,
      config.onEmailEvent.fnHandle as FunctionHandle<"mutation">,
      {
        emailId: outboundEmailId ?? null,
        event: raw,
      },
    );
  }
}

export const fetchAndStoreInbound = internalAction({
  args: {
    config: vRuntimeConfig,
    inboxId: v.number(),
    messageId: v.string(),
    eventId: v.string(),
    from: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let message: any;
    try {
      message = await inboundFetch(
        `/inboxes/${args.inboxId}/messages/${args.messageId}`,
        { method: "GET" },
      );
    } catch (err) {
      if (err instanceof MailtrapApiError && err.permanent) {
        return;
      }
      throw err;
    }

    await ctx.runMutation(internal.lib.storeInboundMessage, {
      config: args.config,
      eventId: args.eventId,
      message,
      fallbackFrom: args.from,
    });
  },
});

export const storeInboundMessage = internalMutation({
  args: {
    config: vRuntimeConfig,
    eventId: v.string(),
    message: v.any(),
    fallbackFrom: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const m = args.message as Record<string, unknown>;
    const messageId = String(m.id ?? m.message_id ?? "");
    if (!messageId) return;

    const existing = await ctx.db
      .query("inboundMessages")
      .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
      .unique();
    if (existing) return;

    const inboxId = Number(m.inbox_id);
    const threadId =
      m.thread_id != null ? String(m.thread_id) : undefined;
    const toArr = Array.isArray(m.to)
      ? m.to.map(String)
      : typeof m.to === "string"
        ? [m.to]
        : undefined;
    const ccArr = Array.isArray(m.cc) ? m.cc.map(String) : undefined;
    const bccArr = Array.isArray(m.bcc) ? m.bcc.map(String) : undefined;

    const docId = await ctx.db.insert("inboundMessages", {
      inboxId: Number.isFinite(inboxId) ? inboxId : 0,
      messageId,
      threadId,
      eventId: args.eventId,
      from:
        m.from != null
          ? String(m.from)
          : args.fallbackFrom,
      to: toArr,
      cc: ccArr,
      bcc: bccArr,
      replyTo: m.reply_to != null ? String(m.reply_to) : undefined,
      subject: m.subject != null ? String(m.subject) : undefined,
      text: m.text != null ? String(m.text) : undefined,
      html: m.html != null ? String(m.html) : undefined,
      headers: m.headers,
      attachments: m.attachments,
      size: typeof m.size === "number" ? m.size : undefined,
      receivedAt: parseTimestamp(
        (m.received_at as string | number | undefined) ?? undefined,
      ),
      raw: m,
    });

    if (args.config.onMessageReceived?.fnHandle) {
      const stored = await ctx.db.get(docId);
      await callbackPool.enqueueMutation(
        ctx,
        args.config.onMessageReceived.fnHandle as FunctionHandle<"mutation">,
        {
          message: stored,
          eventId: args.eventId,
        },
      );
    }
  },
});

export const listInboundMessages = query({
  args: {
    inboxId: v.optional(v.number()),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.threadId) {
      return await ctx.db
        .query("inboundMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId!))
        .order("asc")
        .collect();
    }
    if (args.inboxId != null) {
      return await ctx.db
        .query("inboundMessages")
        .withIndex("by_inbox", (q) => q.eq("inboxId", args.inboxId!))
        .order("desc")
        .collect();
    }
    return await ctx.db.query("inboundMessages").order("desc").take(100);
  },
});

export const getInboundMessage = query({
  args: { messageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("inboundMessages")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();
  },
});

// ---------------------------------------------------------------------------
// Inbound API wrappers: folders, inboxes, threads, reply/forward
// ---------------------------------------------------------------------------

export const createFolder = action({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const folder = (await inboundFetch("/folders", {
      method: "POST",
      body: { name: args.name },
    })) as any;
    await ctx.runMutation(internal.lib.upsertFolder, { folder });
    return folder;
  },
});

export const listFolders = action({
  args: {},
  handler: async () => {
    return await inboundFetch("/folders", { method: "GET" });
  },
});

export const deleteFolder = action({
  args: { folderId: v.number() },
  handler: async (ctx, args) => {
    await inboundFetch(`/folders/${args.folderId}`, { method: "DELETE" });
    await ctx.runMutation(internal.lib.removeFolder, {
      folderId: args.folderId,
    });
    return null;
  },
});

export const createInbox = action({
  args: {
    folderId: v.number(),
    name: v.string(),
    domainId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const body: Record<string, unknown> = { name: args.name };
    if (args.domainId != null) body.domain_id = args.domainId;
    const inbox = (await inboundFetch(
      `/folders/${args.folderId}/inboxes`,
      { method: "POST", body },
    )) as any;
    await ctx.runMutation(internal.lib.upsertInbox, { inbox });
    return inbox;
  },
});

export const listInboxes = action({
  args: { folderId: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    if (args.folderId != null) {
      return await inboundFetch(`/folders/${args.folderId}/inboxes`, {
        method: "GET",
      });
    }
    return await inboundFetch("/inboxes", { method: "GET" });
  },
});

export const deleteInbox = action({
  args: { inboxId: v.number() },
  handler: async (ctx, args) => {
    await inboundFetch(`/inboxes/${args.inboxId}`, { method: "DELETE" });
    await ctx.runMutation(internal.lib.removeInbox, { inboxId: args.inboxId });
    return null;
  },
});

export const listThreads = action({
  args: {
    inboxId: v.number(),
    search: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    return await inboundFetch(`/inboxes/${args.inboxId}/threads`, {
      method: "GET",
      query: { search: args.search },
    });
  },
});

export const getThread = action({
  args: { inboxId: v.number(), threadId: v.string() },
  handler: async (_ctx, args) => {
    return await inboundFetch(
      `/inboxes/${args.inboxId}/threads/${args.threadId}`,
      { method: "GET" },
    );
  },
});

export const replyToMessage = action({
  args: {
    inboxId: v.number(),
    messageId: v.string(),
    payload: vInboundReplyPayload,
  },
  handler: async (_ctx, args) => {
    return await inboundFetch(
      `/inboxes/${args.inboxId}/messages/${args.messageId}/reply`,
      { method: "POST", body: args.payload },
    );
  },
});

export const replyAllToMessage = action({
  args: {
    inboxId: v.number(),
    messageId: v.string(),
    payload: vInboundReplyPayload,
  },
  handler: async (_ctx, args) => {
    return await inboundFetch(
      `/inboxes/${args.inboxId}/messages/${args.messageId}/reply_all`,
      { method: "POST", body: args.payload },
    );
  },
});

export const forwardMessage = action({
  args: {
    inboxId: v.number(),
    messageId: v.string(),
    payload: vInboundReplyPayload,
  },
  handler: async (_ctx, args) => {
    if (!args.payload.to || args.payload.to.length === 0) {
      throw new Error("forward requires at least one to recipient");
    }
    return await inboundFetch(
      `/inboxes/${args.inboxId}/messages/${args.messageId}/forward`,
      { method: "POST", body: args.payload },
    );
  },
});

export const upsertFolder = internalMutation({
  args: { folder: v.any() },
  handler: async (ctx, args) => {
    const folder = args.folder as Record<string, unknown>;
    const folderId = Number(folder.id);
    if (!Number.isFinite(folderId)) return;
    const existing = await ctx.db
      .query("inboundFolders")
      .withIndex("by_folderId", (q) => q.eq("folderId", folderId))
      .unique();
    const doc = {
      folderId,
      name: String(folder.name ?? ""),
      createdAt: parseTimestamp(folder.created_at as string | undefined),
      updatedAt: parseTimestamp(folder.updated_at as string | undefined),
      raw: folder,
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("inboundFolders", doc);
  },
});

export const removeFolder = internalMutation({
  args: { folderId: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("inboundFolders")
      .withIndex("by_folderId", (q) => q.eq("folderId", args.folderId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const upsertInbox = internalMutation({
  args: { inbox: v.any() },
  handler: async (ctx, args) => {
    const inbox = args.inbox as Record<string, unknown>;
    const inboxId = Number(inbox.id);
    if (!Number.isFinite(inboxId)) return;
    const existing = await ctx.db
      .query("inboundInboxes")
      .withIndex("by_inboxId", (q) => q.eq("inboxId", inboxId))
      .unique();
    const doc = {
      inboxId,
      folderId:
        inbox.folder_id != null ? Number(inbox.folder_id) : undefined,
      name: String(inbox.name ?? ""),
      email: inbox.email != null ? String(inbox.email) : undefined,
      domainId:
        inbox.domain_id != null ? Number(inbox.domain_id) : undefined,
      createdAt: parseTimestamp(inbox.created_at as string | undefined),
      updatedAt: parseTimestamp(inbox.updated_at as string | undefined),
      raw: inbox,
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("inboundInboxes", doc);
  },
});

export const removeInbox = internalMutation({
  args: { inboxId: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("inboundInboxes")
      .withIndex("by_inboxId", (q) => q.eq("inboxId", args.inboxId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const listCachedInboxes = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("inboundInboxes").collect();
  },
});

export const listCachedFolders = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("inboundFolders").collect();
  },
});

// ---------------------------------------------------------------------------
// ComponentApi contract
// ---------------------------------------------------------------------------

type Shape<Ref> =
  Ref extends FunctionReference<infer Kind, any, infer Args, any, any>
    ? { kind: Kind; args: Args }
    : never;
type Drifted = {
  [K in keyof ComponentApi["lib"]]: K extends keyof typeof api.lib
    ? Shape<ComponentApi["lib"][K]> extends Shape<(typeof api.lib)[K]>
      ? never
      : K
    : K;
}[keyof ComponentApi["lib"]];
type Assert<T extends never> = T;
type _ComponentApiInSync = Assert<Drifted>;
void null as unknown as _ComponentApiInSync;
