import { defineApp } from "convex/server";
import mailtrap from "@mailtrap/convex/convex.config.js";

const app = defineApp();
app.use(mailtrap);
export default app;
