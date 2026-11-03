import { type Infer, v } from "convex/values";
import {
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";

export const vOutboundStatus = v.union(
  v.literal("pending"),
  v.literal("queued"),
  v.literal("cancelled"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("soft_bounced"),
  v.literal("bounced"),
  v.literal("suspended"),
  v.literal("unsubscribed"),
  v.literal("opened"),
  v.literal("clicked"),
  v.literal("spam"),
  v.literal("rejected"),
  v.literal("failed"),
);
export type OutboundStatus = Infer<typeof vOutboundStatus>;

export const vStream = v.union(
  v.literal("transactional"),
  v.literal("bulk"),
);
export type Stream = Infer<typeof vStream>;

export const vAddress = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});
export type Address = Infer<typeof vAddress>;

export const vAttachment = v.object({
  filename: v.string(),
  content: v.string(),
  type: v.optional(v.string()),
  disposition: v.optional(v.string()),
  content_id: v.optional(v.string()),
});
export type Attachment = Infer<typeof vAttachment>;

export const vEmailPayload = v.object({
  from: vAddress,
  // Optional so batch `base` can omit recipients (provided per-request).
  to: v.optional(v.array(vAddress)),
  cc: v.optional(v.array(vAddress)),
  bcc: v.optional(v.array(vAddress)),
  reply_to: v.optional(vAddress),
  subject: v.optional(v.string()),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
  attachments: v.optional(v.array(vAttachment)),
  headers: v.optional(v.record(v.string(), v.string())),
  category: v.optional(v.string()),
  custom_variables: v.optional(v.record(v.string(), v.any())),
  template_uuid: v.optional(v.string()),
  template_variables: v.optional(v.record(v.string(), v.any())),
});
export type EmailPayload = Infer<typeof vEmailPayload>;

export const vBatchRequest = v.object({
  to: v.optional(v.array(vAddress)),
  cc: v.optional(v.array(vAddress)),
  bcc: v.optional(v.array(vAddress)),
  reply_to: v.optional(vAddress),
  subject: v.optional(v.string()),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
  attachments: v.optional(v.array(vAttachment)),
  headers: v.optional(v.record(v.string(), v.string())),
  category: v.optional(v.string()),
  custom_variables: v.optional(v.record(v.string(), v.any())),
  template_uuid: v.optional(v.string()),
  template_variables: v.optional(v.record(v.string(), v.any())),
});
export type BatchRequest = Infer<typeof vBatchRequest>;

/** Mailtrap sending webhook event names (as delivered in the payload). */
export const SENDING_EVENT_TYPES = [
  "delivery",
  "soft bounce",
  "bounce",
  "suspension",
  "unsubscribe",
  "open",
  "click",
  "spam",
  "reject",
] as const;

export const vSendingEventType = v.union(
  v.literal("delivery"),
  v.literal("soft bounce"),
  v.literal("bounce"),
  v.literal("suspension"),
  v.literal("unsubscribe"),
  v.literal("open"),
  v.literal("click"),
  v.literal("spam"),
  v.literal("reject"),
);
export type SendingEventType = Infer<typeof vSendingEventType>;

export const vInboundEventType = v.literal("inbound.message_received");
export type InboundEventType = Infer<typeof vInboundEventType>;

export const vEventType = v.union(vSendingEventType, vInboundEventType);
export type EventType = Infer<typeof vEventType>;

export const vRuntimeConfig = v.object({
  retryAttempts: v.number(),
  initialBackoffMs: v.number(),
  sandbox: v.boolean(),
  testInboxId: v.optional(v.number()),
  onEmailEvent: v.optional(v.object({ fnHandle: v.string() })),
  onMessageReceived: v.optional(v.object({ fnHandle: v.string() })),
});
export type RuntimeConfig = Infer<typeof vRuntimeConfig>;

export const vInboundReplyPayload = v.object({
  from: v.optional(vAddress),
  to: v.optional(v.array(vAddress)),
  cc: v.optional(v.array(vAddress)),
  bcc: v.optional(v.array(vAddress)),
  subject: v.optional(v.string()),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
  attachments: v.optional(v.array(vAttachment)),
  headers: v.optional(v.record(v.string(), v.string())),
  category: v.optional(v.string()),
  custom_variables: v.optional(v.record(v.string(), v.any())),
});
export type InboundReplyPayload = Infer<typeof vInboundReplyPayload>;

export type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
export type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
  runQuery: GenericMutationCtx<GenericDataModel>["runQuery"];
};
export type RunActionCtx = {
  runAction: GenericActionCtx<GenericDataModel>["runAction"];
  runMutation: GenericActionCtx<GenericDataModel>["runMutation"];
  runQuery: GenericActionCtx<GenericDataModel>["runQuery"];
};

/** Map Mailtrap sending webhook event → outbound status. */
export function mapSendingEventToStatus(
  event: string,
): OutboundStatus | null {
  switch (event) {
    case "delivery":
      return "delivered";
    case "soft bounce":
      return "soft_bounced";
    case "bounce":
      return "bounced";
    case "suspension":
      return "suspended";
    case "unsubscribe":
      return "unsubscribed";
    case "open":
      return "opened";
    case "click":
      return "clicked";
    case "spam":
      return "spam";
    case "reject":
      return "rejected";
    default:
      return null;
  }
}

/** Monotonic rank so webhooks never downgrade a "worse" or later status incorrectly. */
const STATUS_RANK: Record<OutboundStatus, number> = {
  pending: 0,
  queued: 1,
  cancelled: 2,
  sent: 3,
  opened: 4,
  clicked: 4,
  unsubscribed: 4,
  soft_bounced: 5,
  delivered: 6,
  bounced: 7,
  suspended: 7,
  spam: 7,
  rejected: 7,
  failed: 7,
};

export function shouldUpgradeStatus(
  current: OutboundStatus,
  next: OutboundStatus,
): boolean {
  // Engagement events (open/click) are flags on top of delivery — allow
  // them after delivered, but don't overwrite bounce/reject/fail.
  if (
    (next === "opened" || next === "clicked" || next === "unsubscribed") &&
    (current === "delivered" ||
      current === "sent" ||
      current === "opened" ||
      current === "clicked")
  ) {
    return true;
  }
  return STATUS_RANK[next] > STATUS_RANK[current];
}
