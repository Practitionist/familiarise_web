import { NextRequest } from "next/server";
import { cleanupRoute } from "../../lib/cron/cleanup-route";
import { transferRecordings } from "../../lib/stream/recording-transfer-service";
import {
  initJobSentry,
  flushJobSentry,
} from "../../lib/observability/job-sentry";

export const config = { background: true };

const handlers = cleanupRoute({
  job: "transfer-recordings",
  run: transferRecordings,
  failureMessage: "Recording copy sweep failed",
});

/** Netlify's 202 acknowledges invocation; execution history records the eventual result. */
export default async function recordingTransfer(req: Request): Promise<void> {
  if (req.method !== "POST") return;
  initJobSentry();
  try {
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
