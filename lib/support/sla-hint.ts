import type { Tone } from "@/lib/ui/tone";

import type { SlaState } from "./sla";

const HOUR_MS = 3_600_000;
const hours = (ms: number) => Math.max(1, Math.round(Math.abs(ms) / HOUR_MS));

/** "5h" under two days, "2d 3h" / "7d" from 48 hours up. */
function countdown(ms: number): string {
  const total = hours(ms);
  if (total < 48) return `${total}h`;
  const days = Math.floor(total / 24);
  const rest = total % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** Statutory SLA status badge (`Breached` / `Waiting on customer` / `Due soon` / `On track`). */
export function slaStatusBadge(sla: SlaState | null | undefined): {
  label: "Breached" | "Waiting on customer" | "Due soon" | "On track";
  tone: Tone;
} | null {
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
  if (sla.paused) {
    return { label: "Waiting on customer", tone: "neutral" };
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
  if (sla.paused) {
    return { label: "Waiting on customer", tone: "neutral" };
  }
  if (sla.msToAckDue !== null) {
    return { label: `Reply in ${countdown(sla.msToAckDue)}`, tone: "warning" };
  }
  if (sla.msToResolutionDue !== null) {
    return {
      label: `Due in ${countdown(sla.msToResolutionDue)}`,
      tone: "neutral",
    };
  }
  return null;
}

/** The resolution deadline line beside the case badges; overdue once the clock has run out. */
export function resolutionDeadline(
  sla: SlaState | null | undefined,
): { prefix: string; tone: Tone } | null {
  if (!sla || sla.msToResolutionDue === null) return null;
  return sla.resolutionBreached
    ? { prefix: "Resolution overdue since", tone: "critical" }
    : { prefix: "Resolve by", tone: "neutral" };
}
