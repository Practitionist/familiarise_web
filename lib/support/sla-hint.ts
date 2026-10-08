import type { Tone } from "@/lib/ui/tone";

import type { SlaState } from "./sla";

const HOUR_MS = 3_600_000;
const hours = (ms: number) => Math.max(1, Math.round(Math.abs(ms) / HOUR_MS));

/** Statutory SLA status badge (`Breached` / `Due soon` / `On track`). */
export function slaStatusBadge(
  sla: SlaState | null | undefined,
): { label: "Breached" | "Due soon" | "On track"; tone: Tone } | null {
  if (!sla) return null;
  if (sla.ackBreached || sla.resolutionBreached) {
    return { label: "Breached", tone: "critical" };
  }
  const ackSoon = sla.msToAckDue !== null && sla.msToAckDue <= 6 * HOUR_MS;
  const resolutionSoon =
    sla.msToResolutionDue !== null && sla.msToResolutionDue <= 12 * HOUR_MS;
  if (ackSoon || resolutionSoon) {
    return { label: "Due soon", tone: "warning" };
  }
  if (sla.msToAckDue !== null || sla.msToResolutionDue !== null) {
    return { label: "On track", tone: "neutral" };
  }
  return null;
}

/** The tighter clock that is still running, as a short countdown label. */
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
