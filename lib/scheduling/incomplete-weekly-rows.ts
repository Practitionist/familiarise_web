import { captureThrottled } from "@/lib/observability/throttled-capture";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * One report per call (never per row) for weekly rows a reader refused because
 * their local columns are NULL or invalid; the throttle caps a hot reader at
 * one event per hour per instance.
 */
export function reportIncompleteWeeklyRows(
  refused: readonly { id?: string }[],
  context: { op: string; consultantProfileId?: string },
): void {
  if (refused.length === 0) return;
  captureThrottled(
    "scheduling:weekly-row-local-columns-missing",
    new Error("weekly availability rows without local columns were refused"),
    {
      subsystem: "scheduling",
      op: context.op,
      level: "warning",
      fingerprint: ["weekly-row-local-columns-missing"],
      extra: {
        refusedCount: refused.length,
        refusedIds: refused.slice(0, 10).map((row) => row.id ?? null),
        consultantProfileId: context.consultantProfileId ?? null,
      },
    },
    ONE_HOUR_MS,
  );
}
