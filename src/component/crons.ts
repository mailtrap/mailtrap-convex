import { cronJobs } from "convex/server";
import { api } from "./_generated/api.js";

const crons = cronJobs();

crons.interval(
  "cleanup finalized outbound",
  { hours: 1 },
  api.lib.cleanupFinalizedOutbound,
  {},
);

export default crons;
