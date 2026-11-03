import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vOutboundStatus, vStream } from "./shared.js";

export default defineSchema({
  outboundEmails: defineTable({
    stream: vStream,
    sandbox: v.boolean(),
    testInboxId: v.optional(v.number()),
    // Single-send payload, or the per-request slice when part of a batch.
    payload: v.any(),
    // When set, this row is one request inside a batch group.
    batchId: v.optional(v.id("outboundBatches")),
    batchIndex: v.optional(v.number()),
    status: vOutboundStatus,
    mailtrapMessageId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    opened: v.optional(v.boolean()),
    clicked: v.optional(v.boolean()),
    finalizedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_mailtrapMessageId", ["mailtrapMessageId"])
    .index("by_batchId", ["batchId"])
    .index("by_finalizedAt", ["finalizedAt"]),

  // Groups of emails sent via /api/batch in one API call.
  outboundBatches: defineTable({
    stream: vStream,
    sandbox: v.boolean(),
    testInboxId: v.optional(v.number()),
    base: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    errorMessage: v.optional(v.string()),
    emailIds: v.array(v.id("outboundEmails")),
    finalizedAt: v.optional(v.number()),
  }).index("by_status", ["status"]),

  inboundFolders: defineTable({
    folderId: v.number(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    raw: v.any(),
  }).index("by_folderId", ["folderId"]),

  inboundInboxes: defineTable({
    inboxId: v.number(),
    folderId: v.optional(v.number()),
    name: v.string(),
    email: v.optional(v.string()),
    domainId: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    raw: v.any(),
  })
    .index("by_inboxId", ["inboxId"])
    .index("by_folderId", ["folderId"]),

  inboundMessages: defineTable({
    inboxId: v.number(),
    messageId: v.string(),
    threadId: v.optional(v.string()),
    eventId: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.array(v.string())),
    cc: v.optional(v.array(v.string())),
    bcc: v.optional(v.array(v.string())),
    replyTo: v.optional(v.string()),
    subject: v.optional(v.string()),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
    headers: v.optional(v.any()),
    attachments: v.optional(v.any()),
    size: v.optional(v.number()),
    receivedAt: v.number(),
    raw: v.any(),
  })
    .index("by_inbox", ["inboxId"])
    .index("by_thread", ["threadId"])
    .index("by_messageId", ["messageId"]),

  events: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    mailtrapMessageId: v.optional(v.string()),
    inboxId: v.optional(v.number()),
    inboundMessageId: v.optional(v.string()),
    outboundEmailId: v.optional(v.id("outboundEmails")),
    receivedAt: v.number(),
    raw: v.any(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_mailtrapMessageId", ["mailtrapMessageId"]),
});
