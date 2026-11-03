# Example app

Minimal Convex app demonstrating `@mailtrap/convex` sending and receiving.

## Setup

From the repo root:

```bash
npm install
npm run build
cd example
npx convex dev
```

Set env vars on the deployment:

```bash
npx convex env set MAILTRAP_API_TOKEN <token>
npx convex env set MAILTRAP_WEBHOOK_SECRET <secret>
# optional, for sandbox sends
npx convex env set MAILTRAP_TEST_INBOX_ID <inbox_id>
```

Webhook URL to register in Mailtrap:

`https://<deployment>.convex.site/mailtrap/webhook`
