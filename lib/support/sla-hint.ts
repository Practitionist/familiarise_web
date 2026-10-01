import type { Tone } from "@/lib/ui/tone";

import type { SlaState } from "./sla";

const hours = (ms: number) => Math.max(1, Math.round(Math.abs(ms) / 3_600_000));

/** #1527 — the tighter clock that is still running, as a short label. */
export function slaHint(
  sla: SlaState | null | undefined,
): { label: string; tone: Tone } | null {
  if (!sla) return null;
  if (sla.ackBreached) return { label: "Reply overdue", tone: "critical" };
  if (sla.resolutionBreached) {
    return { label: "Resolution overdue", tone: "critical" };
  }
  if (sla.msToAckDue !== null) {
    return { label: `Reply in ${hours(sla.msToAckDue)}h`, tone: "warning" };
  }
  if (sla.msToResolutionDue !== null) {
    return {
      label: `Due in ${hours(sla.msToResolutionDue)}h`,
      tone: "neutral",
    };
  }
  return null;
}
