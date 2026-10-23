import { getMaintenanceState } from "@/lib/maintenance-edge";
import { OpsRefusal } from "./ops-refusal-error";

/**
 * Money and payout-hold doors stop in DEGRADED or OFFLINE maintenance, and
 * fail closed when the maintenance phase cannot be read.
 */
export async function assertMoneyDoorsOpen(): Promise<void> {
  await assertDoorsOpen("Money actions");
}

/** Booking doors follow the participant booking routes' maintenance block. */
export async function assertBookingDoorsOpen(): Promise<void> {
  await assertDoorsOpen("Booking changes");
}

async function assertDoorsOpen(what: string): Promise<void> {
  const state = await getMaintenanceState();
  if (state.unreadable) {
    throw new OpsRefusal(
      "MAINTENANCE_UNKNOWN",
      `${what} are paused because the maintenance status could not be read. Try again shortly.`,
      503,
    );
  }
  if (state.phase !== "OFF") {
    throw new OpsRefusal(
      "MAINTENANCE",
      `${what} are paused during maintenance.`,
      503,
    );
  }
}
