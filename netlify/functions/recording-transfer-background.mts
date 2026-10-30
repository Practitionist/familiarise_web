import { cleanupRoute } from "../../lib/cron/cleanup-route";
import { runBackgroundWorker } from "../../lib/cron/background-worker";
import { transferRecordings } from "../../lib/stream/recording-transfer-service";

export const config = { background: true };

const handlers = cleanupRoute({
  job: "transfer-recordings",
  run: transferRecordings,
  failureMessage: "Recording copy sweep failed",
});

/** Netlify's 202 acknowledges invocation; execution history records the eventual result. */
export default async function recordingTransfer(
  req: Request,
  context?: unknown,
): Promise<void> {
  if (req.method !== "POST") return;
  await runBackgroundWorker(
    "transfer-recordings",
    req,
    context,
    () => handlers,
  );
}
