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
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import type { TeamMember } from "./types";

const clockTime = (at: string, zone: string): string =>
  formatInViewerZone(at, zone, "h:mm a");

/** A session's calendar day in `zone`: "Wed, 18 Nov 2026". */
export const formatSessionDay = (at: string, zone: string): string =>
  formatInViewerZone(at, zone, "EEE, d MMM yyyy");

/** A session's start in `zone`, with the zone named: "6:15 PM IST". */
export const formatSessionStart = (at: string, zone: string): string =>
  `${clockTime(at, zone)} ${zoneLabel(at, zone)}`;

/** A session's hours in `zone`, the zone named once: "6:15 PM – 7:45 PM IST". */
export const formatSessionHours = (
  startsAt: string,
  endsAt: string,
  zone: string,
): string =>
  `${clockTime(startsAt, zone)} – ${clockTime(endsAt, zone)} ${zoneLabel(startsAt, zone)}`;

const RUNTIME_DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * A day as these screens print it, "30 November 2026": the calendar day in
 * `zone`, the viewer's profile zone. A caller with no zone to give gets the
 * runtime's.
 */
export const formatDay = (date: Date | string, zone?: string): string =>
  zone
    ? formatInViewerZone(date, zone, "d MMMM yyyy")
    : RUNTIME_DAY.format(new Date(date));

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
