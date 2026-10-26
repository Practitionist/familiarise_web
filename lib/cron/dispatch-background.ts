import { z } from "zod";
import { STREAM_LIFECYCLE_JOBS, targetRequest } from "@/lib/cron/schedule";

export const backgroundJobSchema = z.enum([
  "transfer-recordings",
  ...STREAM_LIFECYCLE_JOBS,
]);
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

/** Queue admission only; the background core owns execution history and completion. */
export async function dispatchBackgroundJob(
  job: BackgroundJob,
  options: { dryRun?: boolean } = {},
) {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!secret) throw new Error("Stream worker authentication is unconfigured");
  const origin = z
    .string()
    .url()
    .parse(
      process.env.CRON_TICK_BASE_URL ||
        process.env.URL ||
        process.env.NEXT_PUBLIC_APP_URL,
    );
  const configured = new URL(origin);
  if (
    configured.protocol !== "https:" ||
    configured.username ||
    configured.password
  ) {
    throw new Error(
      "Stream worker requires a configured HTTPS origin without credentials",
    );
  }
  const destination = new URL(targetRequest(configured.origin, job).url);
  if (job === "stream-sync" && options.dryRun)
    destination.searchParams.set("dry-run", "true");
  const response = await fetch(destination, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) {
    throw new Error(`Stream worker admission returned HTTP ${response.status}`);
  }
  return { accepted: true, job };
}
