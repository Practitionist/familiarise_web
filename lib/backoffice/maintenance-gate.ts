import { getMaintenanceState } from "@/lib/maintenance-edge";
import { OpsRefusal } from "./ops-refusal-error";

/**
 * Money and payout-hold doors stop in DEGRADED or OFFLINE maintenance, and
 * fail closed when the maintenance phase cannot be read.
 */
export async function assertMoneyDoorsOpen(): Promise<void> {
  const state = await getMaintenanceState();
  if (state.unreadable) {
    throw new OpsRefusal(
      "MAINTENANCE_UNKNOWN",
      "Money actions are paused because the maintenance status could not be read. Try again shortly.",
      503,
    );
  }
  if (state.phase !== "OFF") {
    throw new OpsRefusal(
      "MAINTENANCE",
      "Money actions are paused during maintenance.",
      503,
    );
  }
}
