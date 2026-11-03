import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components } from "./_generated/api";
import { Mailtrap } from "@mailtrap/convex";

const mailtrap: Mailtrap = new Mailtrap(components.mailtrap);
const http = httpRouter();

http.route({
  path: "/mailtrap/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => mailtrap.handleWebhook(ctx, req)),
});

export default http;
