import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Mailtrap, type EmailId } from "@mailtrap/convex";

// Annotated: `internal` is derived from this module's exports, whose types
// depend on `mailtrap`, so inference alone would be circular.
const mailtrap: Mailtrap = new Mailtrap(components.mailtrap, {
  onEmailEvent: internal.example.onEmailEvent,
  onMessageReceived: internal.example.onMessageReceived,
});

/** Queue a transactional email. */
export const sendTestEmail = mutation({
  args: {
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    fromEmail: v.string(),
    fromName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await mailtrap.sendEmail(ctx, {
      from: { email: args.fromEmail, name: args.fromName },
      to: [{ email: args.to }],
      subject: args.subject,
      text: args.text,
      category: "convex-example",
      stream: "transactional",
    });
  },
});

/** Queue a sandbox email (requires MAILTRAP_TEST_INBOX_ID + sandbox: true). */
export const sendSandboxEmail = mutation({
  args: {
    to: v.string(),
    subject: v.string(),
    html: v.string(),
    fromEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const sandboxClient: Mailtrap = new Mailtrap(components.mailtrap, {
      sandbox: true,
      onEmailEvent: internal.example.onEmailEvent,
    });
    return await sandboxClient.sendEmail(ctx, {
      from: { email: args.fromEmail },
      to: [{ email: args.to }],
      subject: args.subject,
      html: args.html,
    });
  },
});

/** Batch send. */
export const sendBatch = mutation({
  args: {
    fromEmail: v.string(),
    subject: v.string(),
    recipients: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    return await mailtrap.sendBatch(ctx, {
      base: {
        from: { email: args.fromEmail },
        subject: args.subject,
        text: "Batch hello from @mailtrap/convex",
      },
      requests: args.recipients.map((email) => ({
        to: [{ email }],
      })),
    });
  },
});

export const emailStatus = query({
  args: { emailId: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.status(ctx, args.emailId as EmailId);
  },
});

export const cancel = mutation({
  args: { emailId: v.string() },
  handler: async (ctx, args) => {
    await mailtrap.cancelEmail(ctx, args.emailId as EmailId);
  },
});

export const listInbox = query({
  args: { inboxId: v.number() },
  handler: async (ctx, args) => {
    return await mailtrap.listInboundMessages(ctx, { inboxId: args.inboxId });
  },
});

export const listThread = query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.listInboundMessages(ctx, {
      threadId: args.threadId,
    });
  },
});

export const createInboundFolder = action({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.createFolder(ctx, args.name);
  },
});

export const createInboundInbox = action({
  args: { folderId: v.number(), name: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.createInbox(ctx, {
      folderId: args.folderId,
      name: args.name,
    });
  },
});

export const reply = action({
  args: {
    inboxId: v.number(),
    messageId: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    return await mailtrap.reply(ctx, args.inboxId, args.messageId, {
      text: args.text,
    });
  },
});

export const onEmailEvent = internalMutation({
  args: { emailId: v.union(v.string(), v.null()), event: v.any() },
  handler: async (_ctx, args) => {
    console.log("Mailtrap email event", args.emailId, args.event?.event);
  },
});

export const onMessageReceived = internalMutation({
  args: { message: v.any(), eventId: v.string() },
  handler: async (ctx, args) => {
    console.log(
      "Inbound message received",
      args.eventId,
      args.message?.subject,
    );
    await ctx.scheduler.runAfter(0, internal.example.autoReply, {
      inboxId: args.message.inboxId,
      messageId: args.message.messageId,
    });
  },
});

export const autoReply = internalAction({
  args: { inboxId: v.number(), messageId: v.string() },
  handler: async (ctx, args) => {
    await mailtrap.reply(ctx, args.inboxId, args.messageId, {
      text: "Thanks — we got your email.",
    });
  },
});
