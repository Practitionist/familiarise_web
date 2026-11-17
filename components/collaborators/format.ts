/**
 * Words, dates and seat arithmetic for the collaborations screens. Role names
 * come from the one role table; nothing here restates a role or a limit.
 */

import type { StatusBadgeStyle } from "@/lib/labels/session-labels";
import {
  ROLE_INFO,
  type CollaboratorRoleInfo,
} from "@/lib/collaborators/roles";
import { bpsToPercent, percentToBps } from "@/lib/collaborators/rules";
import { prorate } from "@/lib/payments/utils/money";
import type { TeamMember } from "./types";

export function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** A day as these screens print it: "30 November 2026". */
export const formatDay = (date: Date | string): string =>
  DAY.format(new Date(date));

const ROLES: Record<string, CollaboratorRoleInfo | undefined> = ROLE_INFO;

/** A role's name. `HOST` is the plan's own expert, who holds no collaborator row. */
export function formatRole(role: string): string {
  if (role === "HOST") return "Host";
  const info = Object.hasOwn(ROLES, role) ? ROLES[role] : undefined;
  return info?.label ?? "Collaborator";
}

/** Every status carries its word, so none is told by colour alone. */
export const COLLABORATOR_STATUS_BADGE: Record<
  TeamMember["status"],
  StatusBadgeStyle
> = {
  PENDING: {
    label: "Invited",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  ACCEPTED: {
    label: "On the team",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
  },
};

/** The whole percent a row holds, or null when the viewer may not see it. */
export const sharePercentOf = (member: {
  revenueShareBps: number | null;
}): number | null =>
  member.revenueShareBps === null ? null : bpsToPercent(member.revenueShareBps);

/** The percent of a plan its invited and accepted collaborators hold between them. */
export const teamSharePercent = (
  team: readonly { revenueShareBps: number | null }[],
): number =>
  bpsToPercent(team.reduce((sum, c) => sum + (c.revenueShareBps ?? 0), 0));

/**
 * How one seat's price divides before any fee, by the settlement rule: each
 * collaborator takes the floor of their share and the host keeps the rest.
 */
export function seatSlices(
  pricePaise: number,
  sharePercent: number,
  otherSharePercents: readonly number[] = [],
): { collaborator: number; others: number; host: number } {
  const slice = (percent: number) =>
    prorate(pricePaise, percentToBps(percent), 10_000);
  const collaborator = slice(sharePercent);
  const others = otherSharePercents.reduce((sum, p) => sum + slice(p), 0);
  return { collaborator, others, host: pricePaise - collaborator - others };
}
