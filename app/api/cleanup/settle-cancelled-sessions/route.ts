/**
 * Settle Cancelled Class Sessions API Endpoint (#1780 row 4)
 *
 * Thin wrapper around scripts/appointments/settle-cancelled-sessions.ts, the
 * HTTP twin the five-minute ticker calls every 15 minutes (ADR 27).
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { settleCancelledSessions } from "@/scripts/appointments/settle-cancelled-sessions";

export const { GET, POST } = cleanupRoute({
  job: "settle-cancelled-sessions",
  run: (req) => settleCancelledSessions({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    stamped: r.stamped,
    refunded: r.refunded,
    errors: r.errors,
  }),
  failureMessage: "Failed to settle cancelled class sessions",
});
