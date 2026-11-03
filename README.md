# @mailtrap/convex

A [Convex](https://convex.dev) component for [Mailtrap](https://mailtrap.io).

Send transactional and bulk email through the Mailtrap Email API, and receive inbound mail into your Convex database — with durable queues, delivery status, signed webhooks, and reactive queries.

## What you get

- **Durable sending.** `sendEmail` / `sendBatch` enqueue from a mutation; a workpool action calls Mailtrap with bounded retries and backoff.
- **Both streams.** Transactional (`send.api.mailtrap.io`) and bulk (`bulk.api.mailtrap.io`).
- **Batch API.** `sendBatch` uses Mailtrap `/api/batch` (up to 500 messages).
- **Full message options.** `to`, `cc`, `bcc`, `reply_to`, `text`, `html`, attachments, custom headers, `category`, `custom_variables`.
- **Templates.** `template_uuid` + `template_variables`.
- **Sandbox mode.** Route sends to `sandbox.api.mailtrap.io` via config.
- **Live delivery status.** Outbound rows update from sending webhooks (`delivery`, `soft bounce`, `bounce`, `suspension`, `unsubscribe`, `open`, `click`, `spam`, `reject`). Subscribe with `useQuery`.
- **Event callbacks.** Register `onEmailEvent` and `onMessageReceived`.
- **Signed webhooks.** Verifies `Mailtrap-Signature` (HMAC-SHA256 of the raw body). Dedupes by `event_id`.
- **Inbound.** Webhook → fetch full message from the Inbound API → store indexed by inbox and thread. Reply, reply-all, forward, and folder/inbox/thread management.
- **Isolated component tables.** Sandboxed from your app schema.

## Install

```bash
npm install @mailtrap/convex
```

Wire it into your Convex app:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import mailtrap from "@mailtrap/convex/convex.config.js";

const app = defineApp();
app.use(mailtrap);
export default app;
```

Set credentials on your Convex deployment (never pass tokens as mutation arguments):

```bash
npx convex env set MAILTRAP_API_TOKEN your_api_token
npx convex env set MAILTRAP_WEBHOOK_SECRET your_webhook_signing_secret
# Required only when sandbox: true
npx convex env set MAILTRAP_TEST_INBOX_ID 123456
```

## Send email

```ts
// convex/email.ts
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Mailtrap } from "@mailtrap/convex";
import { v } from "convex/values";

const mailtrap = new Mailtrap(components.mailtrap);

export const sendWelcome = mutation({
  args: { to: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.sendEmail(ctx, {
      from: { email: "noreply@your-domain.com", name: "Acme" },
      to: [{ email: args.to }],
      subject: "Welcome",
      html: "<p>Hello!</p>",
      text: "Hello!",
      category: "welcome",
      custom_variables: { user_id: "42" },
      stream: "transactional", // or "bulk"
    });
  },
});

export const status = query({
  args: { emailId: v.string() },
  handler: async (ctx, args) => {
    return await mailtrap.status(ctx, args.emailId as any);
  },
});
```

```tsx
const status = useQuery(api.email.status, { emailId });
// → { status: "sent" | "delivered" | "bounced" | ..., mailtrapMessageId, ... }
```

### Templates

```ts
await mailtrap.sendEmail(ctx, {
  from: { email: "noreply@your-domain.com" },
  to: [{ email: "user@example.com" }],
  template_uuid: "bfa432fd-0000-0000-0000-8493da283a69",
  template_variables: { user_name: "Ada" },
});
```

### Batch send

```ts
await mailtrap.sendBatch(ctx, {
  stream: "bulk",
  base: {
    from: { email: "noreply@your-domain.com" },
    subject: "Newsletter",
    html: "<p>Hi</p>",
  },
  requests: [
    { to: [{ email: "a@example.com" }], custom_variables: { n: 1 } },
    { to: [{ email: "b@example.com" }], custom_variables: { n: 2 } },
  ],
});
```

### Sandbox mode

```ts
const mailtrap = new Mailtrap(components.mailtrap, {
  sandbox: true,
  // or set MAILTRAP_TEST_INBOX_ID
  testInboxId: 123456,
});
```

### Cancel

```ts
await mailtrap.cancelEmail(ctx, emailId); // only while pending/queued
```

## Receive mail

Mount the webhook handler in `convex/http.ts`:

```ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components } from "./_generated/api";
import { Mailtrap } from "@mailtrap/convex";

const mailtrap = new Mailtrap(components.mailtrap);
const http = httpRouter();

http.route({
  path: "/mailtrap/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => mailtrap.handleWebhook(ctx, req)),
});

export default http;
```

Register the URL in the Mailtrap dashboard (Email Sending and/or Inbound):

`https://<your-deployment>.convex.site/mailtrap/webhook`

Copy the webhook signing secret into `MAILTRAP_WEBHOOK_SECRET`.

### Query inbound messages

```ts
export const listThread = query({
  args: { threadId: v.string() },
  handler: (ctx, { threadId }) =>
    mailtrap.listInboundMessages(ctx, { threadId }),
});

export const listInbox = query({
  args: { inboxId: v.number() },
  handler: (ctx, { inboxId }) =>
    mailtrap.listInboundMessages(ctx, { inboxId }),
});
```

When `inbound.message_received` arrives, the component fetches the full message from `GET /api/inbound/inboxes/{inbox_id}/messages/{id}` and stores subject, bodies, headers, attachments, and `thread_id`.

### React to inbound mail

Schedule an action for reply/forward (they need an action context):

```ts
import { internalAction, internalMutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Mailtrap } from "@mailtrap/convex";

const mailtrap: Mailtrap = new Mailtrap(components.mailtrap, {
  onMessageReceived: internal.email.onMessageReceived,
  onEmailEvent: internal.email.onEmailEvent,
});

export const onMessageReceived = internalMutation({
  args: { message: v.any(), eventId: v.string() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.email.autoReply, {
      inboxId: args.message.inboxId,
      messageId: args.message.messageId,
    });
  },
});

export const autoReply = internalAction({
  args: { inboxId: v.number(), messageId: v.string() },
  handler: async (ctx, args) => {
    await mailtrap.reply(ctx, args.inboxId, args.messageId, {
      text: "Thanks — we will get back to you shortly.",
    });
  },
});
```

### Reply, reply-all, forward

```ts
await mailtrap.reply(ctx, inboxId, messageId, { text: "Thanks!" });
await mailtrap.replyAll(ctx, inboxId, messageId, { html: "<p>Thanks all</p>" });
await mailtrap.forward(ctx, inboxId, messageId, {
  to: [{ email: "colleague@example.com" }],
  text: "FYI",
});
```

### Manage folders, inboxes, threads

```ts
const folder = await mailtrap.createFolder(ctx, "Support");
const inbox = await mailtrap.createInbox(ctx, {
  folderId: folder.id,
  name: "Tickets",
});
await mailtrap.listFolders(ctx);
await mailtrap.listInboxes(ctx, folder.id);
await mailtrap.listThreads(ctx, inbox.id);
await mailtrap.deleteInbox(ctx, inbox.id);
await mailtrap.deleteFolder(ctx, folder.id);
```

Cached copies (filled on create) are available via:

```ts
await mailtrap.listCachedFolders(ctx);
await mailtrap.listCachedInboxes(ctx);
```

## Configuration

`new Mailtrap(component, options?)` — credentials are **not** accepted in options (except optional `webhookSecret` override for local testing). They are read from the deployment env so they never appear in mutation argument logs.

| Option | Env var | Default |
| --- | --- | --- |
| — | `MAILTRAP_API_TOKEN` | _required_ |
| `webhookSecret` | `MAILTRAP_WEBHOOK_SECRET` | _required for webhooks_ |
| `sandbox` | — | `false` |
| `testInboxId` | `MAILTRAP_TEST_INBOX_ID` | required when `sandbox: true` |
| `retryAttempts` | — | `5` |
| `initialBackoffMs` | — | `30000` |
| `onEmailEvent` | — | none |
| `onMessageReceived` | — | none |

### Retention

Finalized outbound rows are kept for 7 days, then swept by an hourly cron. To sweep sooner:

```ts
await ctx.runMutation(components.mailtrap.lib.cleanupFinalizedOutbound, {
  olderThan: 1000 * 60 * 60, // 1 hour
});
```

## Example app

See [`example/`](./example) for a small Convex app that demonstrates sending, batching, sandbox, webhooks, and inbound callbacks.

```bash
npm install
npm run build
# Configure example/.env.local with CONVEX_DEPLOYMENT, then:
npx convex dev --configure=existing
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## License

MIT
