import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
} from "convex/server";
import { v, type VString } from "convex/values";
import {
  type BatchRequest,
  type EmailPayload,
  type InboundReplyPayload,
  type RunActionCtx,
  type RunMutationCtx,
  type RunQueryCtx,
  type RuntimeConfig,
  type Stream,
} from "../component/shared.js";
import {
  verifyAndParseWebhook,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "./webhook.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";

export type MailtrapComponent = ComponentApi;

export type EmailId = Id<"outboundEmails">;
export const vEmailId = v.string() as VString<EmailId>;

export type BatchId = Id<"outboundBatches">;
export const vBatchId = v.string() as VString<BatchId>;

export {
  vOutboundStatus,
  vStream,
  vEmailPayload,
  vBatchRequest,
  vAddress,
  vAttachment,
  mapSendingEventToStatus,
} from "../component/shared.js";
export type {
  OutboundStatus,
  Stream,
  EmailPayload,
  BatchRequest,
  Address,
  Attachment,
  InboundReplyPayload,
  SendingEventType,
} from "../component/shared.js";
export {
  verifyWebhookSignature,
  verifyAndParseWebhook,
  WebhookVerificationError,
} from "./webhook.js";

const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 30_000;

type Config = {
  webhookSecret: string;
  retryAttempts: number;
  initialBackoffMs: number;
  sandbox: boolean;
  testInboxId?: number;
};

export type MailtrapOptions = {
  /** Override `MAILTRAP_WEBHOOK_SECRET` for the webhook handler. */
  webhookSecret?: string;
  /** Send via sandbox.api.mailtrap.io. Requires testInboxId / MAILTRAP_TEST_INBOX_ID. */
  sandbox?: boolean;
  /** Sandbox inbox id (or set MAILTRAP_TEST_INBOX_ID). */
  testInboxId?: number;
  initialBackoffMs?: number;
  retryAttempts?: number;
  /** Mutation invoked on every sending webhook event. */
  onEmailEvent?: FunctionReference<
    "mutation",
    FunctionVisibility,
    { emailId: string | null; event: unknown }
  > | null;
  /** Mutation invoked after an inbound message is fetched and stored. */
  onMessageReceived?: FunctionReference<
    "mutation",
    FunctionVisibility,
    { message: unknown; eventId: string }
  > | null;
};

export class Mailtrap {
  public config: Config;
  private onEmailEvent?: MailtrapOptions["onEmailEvent"];
  private onMessageReceived?: MailtrapOptions["onMessageReceived"];

  /**
   * @param component e.g. `components.mailtrap`
   * @param options Non-secret tuning. Credentials come from env vars only.
   */
  constructor(
    public component: ComponentApi,
    options?: MailtrapOptions,
  ) {
    const envInbox = process.env.MAILTRAP_TEST_INBOX_ID;
    this.config = {
      webhookSecret:
        options?.webhookSecret ?? process.env.MAILTRAP_WEBHOOK_SECRET ?? "",
      initialBackoffMs: options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      retryAttempts: options?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
      sandbox: options?.sandbox ?? false,
      testInboxId:
        options?.testInboxId ??
        (envInbox != null && envInbox !== ""
          ? Number(envInbox)
          : undefined),
    };
    this.onEmailEvent = options?.onEmailEvent ?? undefined;
    this.onMessageReceived = options?.onMessageReceived ?? undefined;
  }

  // ---- Sending -----------------------------------------------------------

  /**
   * Queue one email from a mutation. A background action calls Mailtrap
   * with retries. Returns an EmailId for reactive status via {@link status}.
   */
  async sendEmail(
    ctx: RunMutationCtx,
    args: EmailPayload & { stream?: Stream },
  ): Promise<EmailId> {
    this.assertConfigured("send");
    const { stream = "transactional", ...payload } = args;
    const id = await ctx.runMutation(this.component.lib.enqueueSend, {
      config: await this.runtimeConfig(),
      stream,
      payload,
    });
    return id as EmailId;
  }

  /**
   * Queue many emails and send them with Mailtrap `/api/batch`.
   */
  async sendBatch(
    ctx: RunMutationCtx,
    args: {
      base: EmailPayload;
      requests: BatchRequest[];
      stream?: Stream;
    },
  ): Promise<{ batchId: BatchId; emailIds: EmailId[] }> {
    this.assertConfigured("send");
    const result = await ctx.runMutation(this.component.lib.enqueueBatch, {
      config: await this.runtimeConfig(),
      stream: args.stream ?? "transactional",
      base: args.base,
      requests: args.requests,
    });
    return {
      batchId: result.batchId as BatchId,
      emailIds: result.emailIds as EmailId[],
    };
  }

  async cancelEmail(ctx: RunMutationCtx, emailId: EmailId) {
    await ctx.runMutation(this.component.lib.cancelEmail, { emailId });
  }

  async status(ctx: RunQueryCtx, emailId: EmailId) {
    return await ctx.runQuery(this.component.lib.getOutboundStatus, {
      emailId,
    });
  }

  async get(ctx: RunQueryCtx, emailId: EmailId) {
    return await ctx.runQuery(this.component.lib.getOutboundEmail, {
      emailId,
    });
  }

  // ---- Inbound queries ---------------------------------------------------

  async listInboundMessages(
    ctx: RunQueryCtx,
    args: { inboxId?: number; threadId?: string } = {},
  ) {
    return await ctx.runQuery(this.component.lib.listInboundMessages, args);
  }

  async getInboundMessage(ctx: RunQueryCtx, messageId: string) {
    return await ctx.runQuery(this.component.lib.getInboundMessage, {
      messageId,
    });
  }

  async listCachedInboxes(ctx: RunQueryCtx) {
    return await ctx.runQuery(this.component.lib.listCachedInboxes, {});
  }

  async listCachedFolders(ctx: RunQueryCtx) {
    return await ctx.runQuery(this.component.lib.listCachedFolders, {});
  }

  // ---- Inbound management (actions) --------------------------------------

  async createFolder(ctx: RunActionCtx, name: string) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.createFolder, { name });
  }

  async listFolders(ctx: RunActionCtx) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.listFolders, {});
  }

  async deleteFolder(ctx: RunActionCtx, folderId: number) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.deleteFolder, { folderId });
  }

  async createInbox(
    ctx: RunActionCtx,
    args: { folderId: number; name: string; domainId?: number },
  ) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.createInbox, args);
  }

  async listInboxes(ctx: RunActionCtx, folderId?: number) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.listInboxes, { folderId });
  }

  async deleteInbox(ctx: RunActionCtx, inboxId: number) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.deleteInbox, { inboxId });
  }

  async listThreads(
    ctx: RunActionCtx,
    inboxId: number,
    args: { search?: string } = {},
  ) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.listThreads, {
      inboxId,
      search: args.search,
    });
  }

  async getThread(ctx: RunActionCtx, inboxId: number, threadId: string) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.getThread, {
      inboxId,
      threadId,
    });
  }

  async reply(
    ctx: RunActionCtx,
    inboxId: number,
    messageId: string,
    payload: InboundReplyPayload,
  ) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.replyToMessage, {
      inboxId,
      messageId,
      payload,
    });
  }

  async replyAll(
    ctx: RunActionCtx,
    inboxId: number,
    messageId: string,
    payload: InboundReplyPayload,
  ) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.replyAllToMessage, {
      inboxId,
      messageId,
      payload,
    });
  }

  async forward(
    ctx: RunActionCtx,
    inboxId: number,
    messageId: string,
    payload: InboundReplyPayload,
  ) {
    this.assertConfigured("send");
    return await ctx.runAction(this.component.lib.forwardMessage, {
      inboxId,
      messageId,
      payload,
    });
  }

  // ---- Webhook -----------------------------------------------------------

  /**
   * Verify Mailtrap-Signature and dispatch events. Mount in `convex/http.ts`.
   */
  async handleWebhook(
    ctx: RunMutationCtx,
    req: Request,
  ): Promise<Response> {
    this.assertConfigured("webhook");
    const raw = await req.text();
    const signature =
      req.headers.get("Mailtrap-Signature") ??
      req.headers.get("mailtrap-signature");

    let events: unknown[];
    try {
      events = await verifyAndParseWebhook(
        this.config.webhookSecret,
        raw,
        signature,
      );
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return new Response("invalid signature", { status: 401 });
      }
      throw err;
    }

    await ctx.runMutation(this.component.lib.handleEvents, {
      config: await this.runtimeConfig(),
      events,
    });

    return new Response(null, { status: 200 });
  }

  // ---- Internals ---------------------------------------------------------

  private async runtimeConfig(): Promise<RuntimeConfig> {
    return {
      retryAttempts: this.config.retryAttempts,
      initialBackoffMs: this.config.initialBackoffMs,
      sandbox: this.config.sandbox,
      testInboxId: this.config.testInboxId,
      onEmailEvent: this.onEmailEvent
        ? { fnHandle: await createFunctionHandle(this.onEmailEvent) }
        : undefined,
      onMessageReceived: this.onMessageReceived
        ? { fnHandle: await createFunctionHandle(this.onMessageReceived) }
        : undefined,
    };
  }

  private assertConfigured(mode: "send" | "webhook") {
    if (mode === "send" && !process.env.MAILTRAP_API_TOKEN) {
      throw new Error(
        "MAILTRAP_API_TOKEN is not set on the Convex deployment. Run " +
          "`npx convex env set MAILTRAP_API_TOKEN <token>`.",
      );
    }
    if (mode === "webhook" && !this.config.webhookSecret) {
      throw new Error(
        "MAILTRAP_WEBHOOK_SECRET is not set. Pass webhookSecret to the Mailtrap constructor or set the env var.",
      );
    }
    if (
      mode === "send" &&
      this.config.sandbox &&
      this.config.testInboxId == null
    ) {
      throw new Error(
        "sandbox: true requires testInboxId or MAILTRAP_TEST_INBOX_ID",
      );
    }
  }
}
