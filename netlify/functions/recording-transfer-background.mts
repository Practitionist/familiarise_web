import { NextRequest } from "next/server.js";
import { getCleanupJobHandlers } from "../../lib/cron/cleanup-registry";
import {
  initJobSentry,
  flushJobSentry,
} from "../../lib/observability/job-sentry";

export const config = { background: true };

/** Netlify's 202 acknowledges invocation; execution history records the eventual result. */
export default async function recordingTransfer(req: Request): Promise<void> {
  if (req.method !== "POST") return;
  initJobSentry();
  try {
    const handlers = getCleanupJobHandlers("transfer-recordings");
    if (!handlers)
      throw new Error("Recording transfer cleanup handler is not registered");
    const response = await handlers.POST(new NextRequest(req));
    if (response.status >= 500) {
      throw new Error(
        `Recording transfer worker returned HTTP ${response.status}`,
      );
    }
  } finally {
    await flushJobSentry();
  }
}
