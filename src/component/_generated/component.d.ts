/* eslint-disable */
/**
 * `ComponentApi` for @mailtrap/convex.
 *
 * Hand-authored to mirror the public surface of src/component/lib.ts.
 * Keep in sync when adding or changing exposed functions.
 * @module
 */
import type { FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type {
  BatchRequest,
  EmailPayload,
  InboundReplyPayload,
  OutboundStatus,
  RuntimeConfig,
  Stream,
} from "../shared.js";

export declare type ComponentApi<
  Name extends string | undefined = string | undefined,
> = {
  lib: {
    enqueueSend: FunctionReference<
      "mutation",
      "internal",
      {
        config: RuntimeConfig;
        stream: Stream;
        payload: EmailPayload;
      },
      GenericId<"outboundEmails">,
      Name
    >;
    enqueueBatch: FunctionReference<
      "mutation",
      "internal",
      {
        config: RuntimeConfig;
        stream: Stream;
        base: EmailPayload;
        requests: Array<BatchRequest>;
      },
      {
        batchId: GenericId<"outboundBatches">;
        emailIds: Array<GenericId<"outboundEmails">>;
      },
      Name
    >;
    cancelEmail: FunctionReference<
      "mutation",
      "internal",
      { emailId: GenericId<"outboundEmails"> },
      null,
      Name
    >;
    getOutboundStatus: FunctionReference<
      "query",
      "internal",
      { emailId: GenericId<"outboundEmails"> },
      {
        status: OutboundStatus;
        mailtrapMessageId: string | null;
        errorMessage: string | null;
        opened: boolean;
        clicked: boolean;
        stream: Stream;
        sandbox: boolean;
      } | null,
      Name
    >;
    getOutboundEmail: FunctionReference<
      "query",
      "internal",
      { emailId: GenericId<"outboundEmails"> },
      any,
      Name
    >;
    cleanupFinalizedOutbound: FunctionReference<
      "mutation",
      "internal",
      { olderThan?: number },
      { deleted: number },
      Name
    >;
    markSendFailed: FunctionReference<
      "mutation",
      "internal",
      { outboundId: GenericId<"outboundEmails">; errorMessage: string },
      null,
      Name
    >;
    markBatchFailed: FunctionReference<
      "mutation",
      "internal",
      { batchId: GenericId<"outboundBatches">; errorMessage: string },
      null,
      Name
    >;
    handleEvents: FunctionReference<
      "mutation",
      "internal",
      { config: RuntimeConfig; events: Array<any> },
      null,
      Name
    >;
    listInboundMessages: FunctionReference<
      "query",
      "internal",
      { inboxId?: number; threadId?: string },
      Array<any>,
      Name
    >;
    getInboundMessage: FunctionReference<
      "query",
      "internal",
      { messageId: string },
      any,
      Name
    >;
    createFolder: FunctionReference<
      "action",
      "internal",
      { name: string },
      any,
      Name
    >;
    listFolders: FunctionReference<"action", "internal", {}, any, Name>;
    deleteFolder: FunctionReference<
      "action",
      "internal",
      { folderId: number },
      null,
      Name
    >;
    createInbox: FunctionReference<
      "action",
      "internal",
      { folderId: number; name: string; domainId?: number },
      any,
      Name
    >;
    listInboxes: FunctionReference<
      "action",
      "internal",
      { folderId?: number },
      any,
      Name
    >;
    deleteInbox: FunctionReference<
      "action",
      "internal",
      { inboxId: number },
      null,
      Name
    >;
    listThreads: FunctionReference<
      "action",
      "internal",
      { inboxId: number; search?: string },
      any,
      Name
    >;
    getThread: FunctionReference<
      "action",
      "internal",
      { inboxId: number; threadId: string },
      any,
      Name
    >;
    replyToMessage: FunctionReference<
      "action",
      "internal",
      {
        inboxId: number;
        messageId: string;
        payload: InboundReplyPayload;
      },
      any,
      Name
    >;
    replyAllToMessage: FunctionReference<
      "action",
      "internal",
      {
        inboxId: number;
        messageId: string;
        payload: InboundReplyPayload;
      },
      any,
      Name
    >;
    forwardMessage: FunctionReference<
      "action",
      "internal",
      {
        inboxId: number;
        messageId: string;
        payload: InboundReplyPayload;
      },
      any,
      Name
    >;
    listCachedInboxes: FunctionReference<"query", "internal", {}, any, Name>;
    listCachedFolders: FunctionReference<"query", "internal", {}, any, Name>;
  };
};
