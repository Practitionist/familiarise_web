import { getAppUrl } from "@/lib/url";

/**
 * Where a notification should land.
 *
 * Several workflows trigger once for many recipients with a single payload, so
 * one href has to be right for every one of them:
 *
 *   - An organisation's work → the organisation route. Right only for people
 *     who belong to that organisation, so pass the organisation of the
 *     recipients' own side: the plan's host organisation for the expert and
 *     team, the booking's sponsor for the buyer. The two differ on a sponsored
 *     booking of an independent expert's plan; send each side separately.
 *   - Personal work → `/dashboard/go/auto/<surface>`. The go resolver picks
 *     each viewer's own dashboard, so the consultant and the consultee both
 *     land on their side of the surface.
 *
 * Use {@link personalHref} instead when a trigger has exactly one recipient and
 * their side is known: a precise link beats a router bounce.
 */

type Surface =
  "appointments" | "requests" | "recordings" | "earnings" | "documents";

/** Recordings and documents are Library tabs for learners and org members. */
function libraryAwarePath(surface: Surface): string {
  return surface === "recordings" || surface === "documents"
    ? `library?tab=${surface}`
    : surface;
}

/**
 * Safe for many recipients on the same side of a booking. `organizationId` is
 * that side's organisation; null means personal.
 */
export function notificationHref(
  organizationId: string | null | undefined,
  surface: Surface,
): string {
  const base = getAppUrl();
  if (!organizationId) {
    // The go resolver picks the viewer's own dashboard. One payload, N
    // recipients, possibly on different sides.
    return `${base}/dashboard/go/auto/${libraryAwarePath(surface)}`;
  }
  return `${base}/dashboard/organization/${organizationId}/${libraryAwarePath(surface)}`;
}

/**
 * One booking's recordings, multi-recipient safe. B2C goes through the go
 * resolver's participation read, so a host lands on their hosted side and an
 * attendee on theirs; org-hosted stays on the org Library.
 */
export function appointmentRecordingsHref(
  organizationId: string | null | undefined,
  appointmentId: string,
): string {
  if (organizationId) return notificationHref(organizationId, "recordings");
  return `${getAppUrl()}/dashboard/go/auto/appointments/${appointmentId}/recordings`;
}

/**
 * Single-recipient variant: when the trigger targets exactly one person and we
 * know which personal dashboard is theirs, link straight to it.
 */
export function personalHref(
  kind: "consultant" | "consultee",
  profileId: string,
  surface: Surface,
): string {
  const path = kind === "consultee" ? libraryAwarePath(surface) : surface;
  return `${getAppUrl()}/dashboard/${kind}/${profileId}/${path}`;
}

/**
 * One recipient whose side is known: the organisation route when their side of
 * the work belongs to one (for an expert, the plan's host organisation), else
 * their personal dashboard.
 */
export function scopedHref(args: {
  organizationId: string | null | undefined;
  surface: Surface;
  personal?: { kind: "consultant" | "consultee"; profileId: string };
}): string {
  if (args.organizationId) {
    return notificationHref(args.organizationId, args.surface);
  }
  if (args.personal) {
    return personalHref(
      args.personal.kind,
      args.personal.profileId,
      args.surface,
    );
  }
  return notificationHref(null, args.surface);
}

/**
 * #1527 — a support request's own page, for the requester's notifications. An
 * org-attributed case opens in that org's dashboard (the requester is a
 * member); B2C goes through the go resolver, which picks the viewer's side.
 */
export function supportRequestHref(
  caseKey: string,
  _organizationId?: string | null,
): string {
  return `${getAppUrl()}/dashboard/support/${caseKey}`;
}
