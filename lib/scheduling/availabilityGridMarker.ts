import { createHash } from "node:crypto";
import type { Db } from "@/lib/prisma";

/**
 * #1319 PR 9 — the change marker behind the availability grid's conditional GET.
 *
 * ADR 16 settled that slot freshness is polled, not pushed, so every open
 * calendar re-asks `/api/scheduling/availability-with-allocation/[consultantId]`
 * once a minute and almost always gets back the answer it already has. This
 * module answers "has anything the response depends on changed?" in ONE
 * indexed read, so the unchanged case can be a 304 instead of the 8–18
 * statements the full grid costs (see docs/booking/20-availability-grid-cost.md).
 *
 * Deliberately raw SQL, against the ORM-first rule. The marker is only worth
 * having if it is CHEAPER than what it replaces, and cost here is round trips,
 * not rows: measured against the shared Supabase instance every statement costs
 * ~30 ms of round trip, PG_POOL_MAX=1 serialises them on Netlify, and
 * Promise.all buys nothing (measured, #1117). Expressed through the ORM this is
 * ten aggregates — ten round trips, i.e. slower than the query it is meant to
 * skip. As one statement it is one round trip.
 */

/**
 * Bump when the response SHAPE changes (new field, different bucketing). Every
 * previously issued ETag then misses and the next poll repaints.
 */
const MARKER_VERSION = "av3";

export interface AvailabilityGridMarker {
  /** Null when no such consultant — the caller must fall through to its 404. */
  profileUpdatedAt: Date | null;
  /** Weekly + custom availability rows for this consultant. */
  availabilityUpdatedAt: Date | null;
  /**
   * Weekly + custom row COUNT. A delete of an older row leaves max(updatedAt)
   * unchanged, so without this the grid could 304 on a calendar that lost a
   * window (review of #1334).
   */
  availabilityRowCount: number;
  /**
   * Payments reaching this calendar. A capture that flips PENDING → SUCCEEDED
   * writes the payment row; the slot/request rows usually move too, but this
   * keeps the marker honest when only the payment does.
   */
  paymentsUpdatedAt: Date | null;
  /** Booked slot rows in the window reaching this consultant (and the consultee, if given). */
  slotsUpdatedAt: Date | null;
  /**
   * COUNT of those in-window slot rows. A reschedule that moves a run out of
   * the window in place leaves max(updatedAt) over the survivors untouched;
   * the count is what moves the tag (#1697 item 1).
   */
  slotRowCount: number;
  /**
   * Co-host seats held by this consultant. Accepting (or losing) a co-host
   * seat changes which appointments the grid counts as busy without touching
   * any appointment row, so membership needs its own arm — otherwise the grid
   * could 304 across the very change that added busy times to it.
   */
  collaboratorsUpdatedAt: Date | null;
  /** Parent request rows — status flips that start or stop occupying. */
  requestsUpdatedAt: Date | null;
  /**
   * Earliest still-future PENDING payment deadline among those appointments.
   * The clock fold: when now() passes it the row drops out of the subquery and
   * this value moves to the next hold, so a lapsing hold changes the ETag even
   * though no row was written. Null when nothing is pending.
   */
  nextHoldExpiry: Date | null;
  /**
   * #1691 Item 2 — the primary consultant's active scheduleType and userId,
   * returned alongside the ETag probe so the availability route only loads the
   * active availability window relation (weekly OR custom) on a cache miss.
   */
  scheduleType?: "WEEKLY" | "CUSTOM" | null;
  consultantUserId?: string | null;
}

/** The half-open window the grid was asked for; the marker is scoped to it. */
export interface AvailabilityGridWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * One statement, one round trip. Every consultant-scoped arm is an index probe
 * (`AppointmentOccurrence_consultantProfileId_startsAt_endsAt_idx`,
 * `AppointmentOccurrence_appointmentId_idx`, `AppointmentParticipant_userId_status_idx`,
 * the four `*Plan_consultantProfileId_idx`, `Payment_expiresAt_paymentStatus_idx`).
 *
 * `reach` is the set of appointments that can paint a cell on THIS window:
 * the ones the occupancy query reaches — the denormalized consultantProfileId
 * (#440), the consultant's own seat (#1554), the consultee's seat when given,
 * the consultant's plan ownership (the same five arms as
 * `buildOccupiedAppointmentFilter`) and ACCEPTED co-host seats (AE-2 #784) —
 * intersected with "has an occurrence overlapping [startsAt, endsAt)".
 *
 * Window-scoped as of #1697 item 1: scoped to the consultant alone, one
 * booking flipped the ETag of every open calendar for that consultant and
 * they all re-demanded full grids at once, serialised on a pool of one. Now
 * a booking six months out leaves this week's tag alone.
 *
 * `consulteeUserId` is the empty string when absent: an index probe that
 * matches nothing, which keeps this one SQL string rather than two.
 */
export interface AvailabilityGridMarkerOptions {
  webinarId?: string | null;
  classId?: string | null;
}

export async function readAvailabilityGridMarker(
  db: Db,
  consultantId: string,
  consulteeUserId: string | null,
  window: AvailabilityGridWindow,
  options?: AvailabilityGridMarkerOptions,
): Promise<AvailabilityGridMarker | null> {
  const consulteeKey = consulteeUserId ?? "";
  const webinarKey = options?.webinarId ?? "";
  const classKey = options?.classId ?? "";
  const rows = await db.$queryRaw<AvailabilityGridMarker[]>`
    WITH event_cohosts AS (
      SELECT cb."consultantProfileId" AS id
        FROM "Collaborator" cb
        JOIN "Webinar" w ON w."webinarPlanId" = cb."webinarPlanId"
       WHERE w.id = ${webinarKey}
         AND cb.status::text = 'ACCEPTED'
      UNION
      SELECT cb."consultantProfileId" AS id
        FROM "Collaborator" cb
        JOIN "Class" cl ON cl."classPlanId" = cb."classPlanId"
       WHERE cl.id = ${classKey}
         AND cb.status::text = 'ACCEPTED'
    ),
    consultant AS (
      SELECT id, "userId", "updatedAt"
        FROM "ConsultantProfile"
       WHERE id = ${consultantId}
      UNION
      SELECT cp.id, cp."userId", cp."updatedAt"
        FROM "ConsultantProfile" cp
        JOIN event_cohosts ec ON ec.id = cp.id
    ),
    candidates AS (
      SELECT s."appointmentId" AS id
        FROM "AppointmentOccurrence" s
        JOIN consultant c ON c.id = s."consultantProfileId"
       WHERE s."startsAt" < ${window.endsAt}
         AND s."endsAt" > ${window.startsAt}
      UNION
      SELECT p."appointmentId"
        FROM "AppointmentParticipant" p
        JOIN consultant c ON c."userId" = p."userId"
      UNION
      SELECT p."appointmentId"
        FROM "AppointmentParticipant" p
       WHERE p."userId" = ${consulteeKey}
      UNION
      SELECT a.id
        FROM "Appointment" a
        JOIN "Consultation" c ON c.id = a."consultationId"
        JOIN "ConsultationPlan" cp ON cp.id = c."consultationPlanId"
        JOIN consultant co ON co.id = cp."consultantProfileId"
      UNION
      SELECT a.id
        FROM "Appointment" a
        JOIN "Subscription" sb ON sb.id = a."subscriptionId"
        JOIN "SubscriptionPlan" sp ON sp.id = sb."subscriptionPlanId"
        JOIN consultant co ON co.id = sp."consultantProfileId"
      UNION
      SELECT a.id
        FROM "Appointment" a
        JOIN "Webinar" w ON w.id = a."webinarId"
        JOIN "WebinarPlan" wp ON wp.id = w."webinarPlanId"
        JOIN consultant co ON co.id = wp."consultantProfileId"
      UNION
      SELECT a.id
        FROM "Appointment" a
        JOIN "Class" cl ON cl.id = a."classId"
        JOIN "ClassPlan" clp ON clp.id = cl."classPlanId"
        JOIN consultant co ON co.id = clp."consultantProfileId"
      UNION
      SELECT ts."appointmentId"
        FROM "Trial" ts
        JOIN consultant co ON co.id = ts."consultantProfileId"
       WHERE ts."appointmentId" IS NOT NULL
      UNION
      -- Co-host commitments: webinar/class appointments on plans where this
      -- consultant (or an event co-host) holds an ACCEPTED seat. Co-hosts are
      -- not slot participants (AE-2 #784), so none of the arms above reach them.
      -- Enum compared as text: Prisma raw SQL has no enum literal binding for this type.
      SELECT a.id
        FROM "Appointment" a
        JOIN "Webinar" w ON w.id = a."webinarId"
        JOIN "Collaborator" cb ON cb."webinarPlanId" = w."webinarPlanId"
        JOIN consultant co ON co.id = cb."consultantProfileId"
       WHERE cb.status::text = 'ACCEPTED'
      UNION
      SELECT a.id
        FROM "Appointment" a
        JOIN "Class" c ON c.id = a."classId"
        JOIN "Collaborator" cb ON cb."classPlanId" = c."classPlanId"
        JOIN consultant co ON co.id = cb."consultantProfileId"
       WHERE cb.status::text = 'ACCEPTED'
    ),
    reach AS (
      SELECT k.id
        FROM candidates k
       WHERE EXISTS (
         SELECT 1
           FROM "AppointmentOccurrence" o
          WHERE o."appointmentId" = k.id
            AND o."startsAt" < ${window.endsAt}
            AND o."endsAt" > ${window.startsAt}
       )
    ),
    window_slots AS (
      SELECT o."updatedAt"
        FROM "AppointmentOccurrence" o
        JOIN reach r ON r.id = o."appointmentId"
       WHERE o."startsAt" < ${window.endsAt}
         AND o."endsAt" > ${window.startsAt}
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM consultant c WHERE c.id = ${consultantId})
        THEN (SELECT max(c."updatedAt") FROM consultant c)
        ELSE NULL
      END AS "profileUpdatedAt",
      (SELECT cp."scheduleType"::text FROM "ConsultantProfile" cp WHERE cp.id = ${consultantId}) AS "scheduleType",
      (SELECT cp."userId" FROM "ConsultantProfile" cp WHERE cp.id = ${consultantId}) AS "consultantUserId",
      (SELECT max(t) FROM (
          SELECT max(w."updatedAt") AS t
            FROM "AvailabilityWindowWeekly" w
            JOIN consultant co ON co.id = w."consultantProfileId"
          UNION ALL
          SELECT max(cu."updatedAt")
            FROM "AvailabilityWindowCustom" cu
            JOIN consultant co ON co.id = cu."consultantProfileId"
       ) a) AS "availabilityUpdatedAt",
      (SELECT (SELECT count(*) FROM "AvailabilityWindowWeekly" w
                 JOIN consultant co ON co.id = w."consultantProfileId")
            + (SELECT count(*) FROM "AvailabilityWindowCustom" cu
                 JOIN consultant co ON co.id = cu."consultantProfileId"))::int
        AS "availabilityRowCount",
      (SELECT max(p."updatedAt")
         FROM "Payment" p
         JOIN reach r ON r.id = p."appointmentId") AS "paymentsUpdatedAt",
      (SELECT max(ws."updatedAt") FROM window_slots ws) AS "slotsUpdatedAt",
      (SELECT count(*) FROM window_slots ws)::int AS "slotRowCount",
      (SELECT max(cb."updatedAt")
         FROM "Collaborator" cb
         JOIN consultant co ON co.id = cb."consultantProfileId") AS "collaboratorsUpdatedAt",
      (SELECT max(t) FROM (
          SELECT max(c."updatedAt") AS t
            FROM "Consultation" c
            JOIN "Appointment" a ON a."consultationId" = c.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(sb."updatedAt")
            FROM "Subscription" sb
            JOIN "Appointment" a ON a."subscriptionId" = sb.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(w."updatedAt")
            FROM "Webinar" w
            JOIN "Appointment" a ON a."webinarId" = w.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(cl."updatedAt")
            FROM "Class" cl
            JOIN "Appointment" a ON a."classId" = cl.id
            JOIN reach r ON r.id = a.id
          UNION ALL
          SELECT max(ts."updatedAt")
            FROM "Trial" ts
            JOIN reach r ON r.id = ts."appointmentId"
       ) b) AS "requestsUpdatedAt",
      (SELECT min(p."expiresAt")
         FROM "Payment" p
         JOIN reach r ON r.id = p."appointmentId"
        WHERE p."paymentStatus" = 'PENDING'
          AND p."expiresAt" > now()) AS "nextHoldExpiry"
  `;

  const row = rows[0];
  // A consultant that does not exist has no profile timestamp. Returning null
  // keeps the route's 404 reachable instead of 304ing a body that never was.
  return row?.profileUpdatedAt ? row : null;
}

/** Everything about the REQUEST that changes the body for the same marker. */
export interface AvailabilityGridEtagKey {
  consultantId: string;
  /** Parsed, so `startDate` and `startDateInUtc` hash identically. */
  startIso: string;
  endIso: string;
  timezone: string;
  /** Resolved, not requested — this is what actually shapes the payload. */
  includeAppointmentDetails: boolean;
  consulteeUserId: string | null;
  webinarId?: string | null;
  classId?: string | null;
}

/**
 * A strong ETag (no `W/`): the bytes really are identical, not just equivalent.
 * Hashed rather than concatenated so the header stays short and leaks no
 * timestamps about a consultant's booking activity to an anonymous caller —
 * this route is public.
 */
export function availabilityGridEtag(
  marker: AvailabilityGridMarker,
  key: AvailabilityGridEtagKey,
): string {
  const iso = (d: Date | null) => (d ? d.toISOString() : "-");
  const material = [
    MARKER_VERSION,
    key.consultantId,
    key.startIso,
    key.endIso,
    key.timezone,
    key.includeAppointmentDetails ? "d1" : "d0",
    key.consulteeUserId ?? "",
    key.webinarId ?? "",
    key.classId ?? "",
    iso(marker.profileUpdatedAt),
    iso(marker.availabilityUpdatedAt),
    String(marker.availabilityRowCount ?? 0),
    iso(marker.slotsUpdatedAt),
    String(marker.slotRowCount ?? 0),
    iso(marker.collaboratorsUpdatedAt),
    iso(marker.paymentsUpdatedAt ?? null),
    iso(marker.requestsUpdatedAt),
    iso(marker.nextHoldExpiry),
  ].join(" ");
  return `"${createHash("sha256").update(material).digest("base64url")}"`;
}

function stripWeakAndQuotes(token: string): string {
  return token
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"|"$/g, "");
}

function stripWeakAndCdnSuffix(token: string): string {
  return stripWeakAndQuotes(token).replace(/-(?:df|gzip|br)$/i, "");
}

/**
 * RFC 9110 §13.1.2 — the header is a comma-separated list, may be `*`, and its
 * entries may be weak. A weak match is enough to skip the body.
 * #1723 — also strips proxy/CDN content-encoding suffixes (`-df`, `-gzip`, `-br`)
 * appended inside client ETag quotes when compressing responses, while keeping
 * the server's `currentEtag` intact (only `^W/` and surrounding quotes removed).
 */
export function ifNoneMatchSatisfied(
  header: string | null,
  currentEtag: string,
): boolean {
  if (!header) return false;
  const target = stripWeakAndQuotes(currentEtag);
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return (
      trimmed === "*" ||
      stripWeakAndQuotes(trimmed) === target ||
      stripWeakAndCdnSuffix(trimmed) === target
    );
  });
}
