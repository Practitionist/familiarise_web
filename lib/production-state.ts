import { jobEnvironment } from "@/lib/cron/run-outcome";

/**
 * Production alone writes the shared state another deploy would flip for it
 * (maintenance phase, the cron heartbeat, the discount snapshot); elsewhere the write is skipped and logged.
 */
export function mayWriteProductionState(key: string): boolean {
  const environment = jobEnvironment();
  if (environment === "production") return true;
  console.log(
    JSON.stringify({
      event: "production-state-write-skipped",
      key,
      environment,
    }),
  );
  return false;
}
