import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import {
  AppointmentSlot,
  CustomSlot,
  dayMap,
  isValidOvernightSlot,
  makeLocalizer,
  processAvailabilitySlots,
  WeeklySlot,
} from "@/utils/scheduling-engine/intervals";
import { NextRequest, NextResponse } from "next/server";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";
import { isOccupiedByLiveAppointment } from "@/utils/scheduling-engine/ScheduleValidationService";
import { getCachedSession, getSession } from "@/lib/auth-server";
import {
  buildOverlapMetaIndex,
  overlapMetaCandidatesFor,
  type OverlapAppointmentMeta,
  type AppointmentForOverlapMeta,
} from "@/lib/booking/overlap-meta";
import { isPrivileged } from "@/lib/auth-helpers";
import { rolesWithOrgPermission } from "@/lib/auth/org-permissions";
import { apiError } from "@/lib/errors/api-error";
import { Refusal } from "@/lib/errors/refusal";
import {
  availabilityGridEtag,
  ifNoneMatchSatisfied,
  readAvailabilityGridMarker,
} from "@/lib/scheduling/availabilityGridMarker";
import { isMinuteWithinWeeklySlot } from "@/utils/scheduling-engine/slotTimeUtils";
import type { TIntervalTiming } from "@/types/slots";
import type { BookingStatus } from "@/utils/scheduling-engine/intervals";

type SlotTimingWithOverlap = TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
  overlappingAppointments?: OverlapAppointmentMeta[];
};

// #1164 — browser-only cache for the polling grid. `private`, not the sibling's
// `public, s-maxage`: the same URL answers differently by session (the
// includeAppointmentDetails/consulteeUserId gates below), so a shared cache
// would cross identities. Bounded staleness is safe — allocation re-validates
// server-side — and the one caller that must never see it, the post-allocation
// refetch, asks for `cache: "no-store"` (AllocationService, #1164).
// No SWR: the 60s poll and return-tick must repaint fresh, not one-interval-old.
const GRID_CACHE_CONTROL = "private, max-age=30";

/**
 * The grid is O(window width) CPU, so a caller asking for a whole scheduling
 * period (1/6/12 months) ran past the ~26 s edge ceiling and got a text/plain
 * timeout. Every client asks for the visible day, week or month; anything
 * wider is refused so it paginates instead of timing out (supersedes #1577).
 */
// 32, not 31: a 31-day month that ends daylight-saving time is 31 d + 1 h of
// elapsed time, and the expert page reads a whole month in one call (#1785).
const MAX_AVAILABILITY_WINDOW_DAYS = 32;
const MAX_AVAILABILITY_WINDOW_MS =
  MAX_AVAILABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// An org operator acting for a member consultant (RequestSchedulingTab
// mounts mode="allocate" for org admins allocating on a consultant's behalf)
// is authorized the same as the owning consultant. isPrivileged only covers
// PLATFORM staff, so without this an org admin 403s and loses the whole
// calendar rather than just the tooltip detail. The roles come from the org
// matrix (#1851); consultantProfileId + role: "EXPERT" identifies the org the
// consultant belongs to.
//
// #1851 decision 10 — only for the org's own members. With a consultee named,
// that person must be an ACTIVE member of the SAME org: the busy/free oracle
// used to answer for any user id on the platform.
async function isOrgAdminOfConsultant(
  userId: string,
  consultantId: string,
  consulteeUserId?: string,
): Promise<boolean> {
  const expertMember = {
    memberships: {
      some: {
        consultantProfileId: consultantId,
        role: "EXPERT" as const,
        status: "ACTIVE" as const,
      },
    },
  };
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      role: {
        in: rolesWithOrgPermission("appointments.allocate.calendarRead"),
      },
      organization: consulteeUserId
        ? {
            AND: [
              expertMember,
              {
                memberships: {
                  some: { userId: consulteeUserId, status: "ACTIVE" },
                },
              },
            ],
          }
        : expertMember,
    },
    select: { id: true },
  });
  return !!membership;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;
    const { searchParams } = new URL(req.url);

    // Support both old and new parameter names for backward compatibility
    const startDateInUtc =
      searchParams.get("startDateInUtc") || searchParams.get("startDate");
    const endDateInUtc =
      searchParams.get("endDateInUtc") || searchParams.get("endDate");
    const timezone = searchParams.get("timezone") || "UTC";

    // #997 Phase 2 — explicit opt-in for the consultant Allocate-Slots
    // calendar's per-interval tooltip metadata (title/participant name).
    // This route is otherwise PUBLIC (consultee/trials browsing, see
    // middleware.ts) so the richer include is gated behind BOTH the flag
    // AND session ownership — a consultee's request never satisfies the
    // ownership check, so their response is byte-identical to before.
    const includeAppointmentDetailsRequested =
      searchParams.get("includeAppointmentDetails") === "true";
    const requestedConsulteeUserId = searchParams.get("consulteeUserId");
    const webinarId = searchParams.get("webinarId");
    const classId = searchParams.get("classId");

    // Both gates below need the caller's identity, and this route is re-hit on
    // every week-slide — so resolve it ONCE rather than awaiting getSession in
    // each gate. Still skipped entirely on the public path, where neither
    // parameter is present and the route stays anonymous.
    // #1697 item 4 — the busy/free shape reads the session cookie-cached (one
    // poll a minute per calendar); the privileged detail shape reads fresh so
    // a demotion or a revoked membership takes effect on the next poll. The
    // cross-user gate below re-reads the role fresh regardless (#1807).
    let session: Awaited<ReturnType<typeof getSession>> = null;
    if (includeAppointmentDetailsRequested) session = await getSession(true);
    else if (requestedConsulteeUserId) session = await getCachedSession();
    // Ownership is a fact about the database, not about the session.
    //
    // The session field is a snapshot from when the session was minted, so a
    // consultant whose profile link changed since then fails this check while
    // requirePersonalProfileAccess — which re-reads the user — lets them onto
    // the page. The result was a page that rendered and then 403'd its own
    // calendar. Session first because it is free and almost always right; the
    // read only happens when it disagrees.
    const isOwningConsultant =
      !!session?.user?.id &&
      (session.user.consultantProfileId === consultantId ||
        (await prisma.consultantProfile.count({
          where: { id: consultantId, userId: session.user.id },
        })) > 0);

    // Resolved lazily, only when details were asked for. The consultee gate
    // below runs its own narrower check, which also needs the consultee to be
    // a member of the admin's org (#1851 decision 10).
    let orgAdminCheck: Promise<boolean> | null = null;
    const isOrgAdmin = () => {
      if (!session?.user?.id) return Promise.resolve(false);
      orgAdminCheck ??= isOrgAdminOfConsultant(session.user.id, consultantId);
      return orgAdminCheck;
    };

    let includeAppointmentDetails = false;
    if (includeAppointmentDetailsRequested) {
      // Three outcomes, not two.
      //
      // The detail payload carries plan titles and participant names. The
      // consultant may see their own; platform staff may see anyone's. An org
      // admin allocating for a member consultant needs the CALENDAR — which
      // cells are taken — but not what each block is: the consultant's personal
      // bookings with unrelated consultees are content, and ADR 20 gives an org
      // metadata, not content.
      //
      // So they are neither authorized nor refused. They get the same
      // busy/free grid a buyer gets, and the allocate surface works. 403ing
      // them cost the whole calendar over a tooltip they must not see anyway.
      const maySeeDetails =
        !!session?.user?.id &&
        (isOwningConsultant || isPrivileged(session.user.role));
      const maySeeCalendar = maySeeDetails || (await isOrgAdmin());

      if (!maySeeCalendar) {
        return apiError({
          tag: "[Availability.GET]",
          error: new Refusal({
            code: "NOT_OWNER",
            httpStatus: 403,
            userMessage:
              "Only this consultant can see their appointment details.",
            devMessage:
              "Forbidden: appointment details require consultant ownership",
            context: { consultantId, userId: session?.user?.id },
          }),
        });
      }
      includeAppointmentDetails = maySeeDetails;
    }

    // The allocator treats the CONSULTEE's bookings with ANY consultant as
    // occupied, so a grid that only knows the consultant paints cells green
    // that then fail validateNoConflicts. Callers who know whose calendar is
    // being booked pass it here.
    //
    // Gated because this route is otherwise PUBLIC: an ungated parameter would
    // be a busy/free oracle for any user id. You may ask about yourself, or the
    // consultant (and staff) may ask about a consultee booking with them.
    let consulteeUserId: string | null = null;
    if (requestedConsulteeUserId) {
      // The org-admin arm belongs here too. This parameter only marks cells
      // BUSY — it carries no titles or names — so it is metadata, which ADR 20
      // does allow an org to see, and allocation is wrong without it: the grid
      // would paint cells green that validation then rejects. It answers only
      // for a consultee in the admin's own org (#1851 decision 10).
      const isSelf = session?.user?.id === requestedConsulteeUserId;
      // Role gates must read fresh even on the cached path: the cached
      // session can lag a demotion or ban by ~5 min (#1807), and this branch
      // authorizes a cross-user oracle. The extra read runs only here — self
      // polls and the public path never reach it, so #1697's poll budget
      // is unchanged.
      const gateRole =
        !isSelf && !isOwningConsultant
          ? (await getSession(true))?.user?.role
          : session?.user?.role;
      if (
        !isSelf &&
        !isOwningConsultant &&
        !isPrivileged(gateRole) &&
        !(
          !!session?.user?.id &&
          (await isOrgAdminOfConsultant(
            session.user.id,
            consultantId,
            requestedConsulteeUserId,
          ))
        )
      ) {
        return NextResponse.json(
          { error: "Forbidden: cannot read another user's calendar" },
          { status: 403 },
        );
      }
      consulteeUserId = requestedConsulteeUserId;
    }

    if (!startDateInUtc || !endDateInUtc) {
      return NextResponse.json(
        { error: "startDateInUtc and endDateInUtc are required" },
        { status: 400 },
      );
    }

    // Validate dates
    let startDate: Date, endDate: Date;
    try {
      startDate = new Date(startDateInUtc);
      endDate = new Date(endDateInUtc);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error("Invalid date format");
      }
    } catch (_error) {
      return NextResponse.json(
        { error: "Dates must be in UTC ISO format" },
        { status: 400 },
      );
    }
    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "endDateInUtc must be after startDateInUtc" },
        { status: 400 },
      );
    }
    if (endDate.getTime() - startDate.getTime() > MAX_AVAILABILITY_WINDOW_MS) {
      return NextResponse.json(
        {
          error: `That date range is too wide. Ask for up to ${MAX_AVAILABILITY_WINDOW_DAYS} days at a time — the visible week or month.`,
          code: "WINDOW_TOO_WIDE",
          maxWindowDays: MAX_AVAILABILITY_WINDOW_DAYS,
        },
        { status: 400 },
      );
    }

    // A client-controlled zone string reaches `new Intl.DateTimeFormat` in the
    // slot localizer, which throws RangeError on a bad IANA name — a 400, not
    // a 500. Validated here so every downstream use is safe.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch (_error) {
      return NextResponse.json(
        { error: "Invalid timezone: must be a valid IANA timezone name" },
        { status: 400 },
      );
    }

    // #1319 PR 9 — conditional GET, computed BEFORE the heavy reads.
    //
    // Every open calendar re-asks this endpoint once a minute (ADR 16: polling,
    // not Realtime) and the answer is almost always the one it already has. One
    // indexed marker read decides that in a single statement, against the 8
    // statements the public grid costs and the 18 the detail grid costs (#997,
    // docs/booking/20-availability-grid-cost.md).
    //
    // Placed after the authorization gates on purpose: a caller who has since
    // lost access is refused up there, so a 304 can never serve stale
    // permission. The resolved (not requested) detail flag and the consultee id
    // are hashed into the tag, so the two payload shapes cannot collide.
    // Window-scoped (#1697): a booking in another week leaves this tag alone.
    const marker = await readAvailabilityGridMarker(
      prisma,
      consultantId,
      consulteeUserId,
      { startsAt: startDate, endsAt: endDate },
      { webinarId, classId },
    );
    // No marker = no such consultant; fall through so the 404 below still answers.
    const etag = marker
      ? availabilityGridEtag(marker, {
          consultantId,
          startIso: startDate.toISOString(),
          endIso: endDate.toISOString(),
          timezone,
          includeAppointmentDetails,
          consulteeUserId,
          webinarId,
          classId,
        })
      : null;
    const ifNoneMatchHeader =
      req.headers.get("if-none-match") ??
      req.headers.get("x-availability-if-none-match");
    if (etag && ifNoneMatchSatisfied(ifNoneMatchHeader, etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { "Cache-Control": GRID_CACHE_CONTROL, ETag: etag },
      });
    }

    // 1. Fetch consultant's availability
    const customWindowOverlapWhere = {
      OR: [
        {
          startsAt: {
            gte: startDate,
            lt: endDate,
          },
        },
        {
          endsAt: {
            gt: startDate,
            lte: endDate,
          },
        },
        {
          startsAt: { lte: startDate },
          endsAt: { gte: endDate },
        },
      ],
    };

    // #1691 Item 2 — When the ETag marker probe already returned the primary
    // consultant's `scheduleType`, only fetch the active availability window
    // relation (`WEEKLY` or `CUSTOM`) instead of loading both tables.
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      include: {
        availabilityWindowsWeekly: marker?.scheduleType
          ? marker.scheduleType === "WEEKLY"
          : true,
        availabilityWindowsCustom:
          !marker?.scheduleType || marker.scheduleType === "CUSTOM"
            ? { where: customWindowOverlapWhere }
            : false,
      },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    if (
      marker?.scheduleType &&
      consultant.scheduleType !== marker.scheduleType
    ) {
      const refetched = await prisma.consultantProfile.findUnique({
        where: { id: consultantId },
        include: {
          availabilityWindowsWeekly: consultant.scheduleType === "WEEKLY",
          availabilityWindowsCustom:
            consultant.scheduleType === "CUSTOM"
              ? { where: customWindowOverlapWhere }
              : false,
        },
      });
      if (refetched) {
        consultant.availabilityWindowsWeekly =
          refetched.availabilityWindowsWeekly;
        consultant.availabilityWindowsCustom =
          refetched.availabilityWindowsCustom;
      }
    }

    // #1689 — When allocating a webinar or class, load ACCEPTED co-hosts so the
    // grid reflects both their busy commitments and their availability schedules.
    type CoHostScheduleProfile = {
      consultantProfileId: string;
      userId: string;
      scheduleType?: string;
      availabilityWindowsWeekly?: WeeklySlot[];
      availabilityWindowsCustom?: { id: string; startsAt: Date; endsAt: Date }[];
    };
    const coHostProfiles: CoHostScheduleProfile[] = [];
    if (webinarId || classId) {
      const collabSelect = {
        where: { status: "ACCEPTED" as const },
        select: {
          consultantProfileId: true,
          consultantProfile: {
            select: {
              id: true,
              userId: true,
              scheduleType: true,
              availabilityWindowsWeekly: true,
              availabilityWindowsCustom: { where: customWindowOverlapWhere },
              user: { select: { id: true } },
            },
          },
        },
      };
      let rawCollabs:
        | Array<{
            consultantProfileId: string;
            consultantProfile?: {
              id?: string;
              userId?: string;
              scheduleType?: string;
              availabilityWindowsWeekly?: WeeklySlot[];
              availabilityWindowsCustom?: {
                id: string;
                startsAt: Date;
                endsAt: Date;
              }[];
              user?: { id?: string } | null;
            } | null;
          }>
        | undefined;
      if (webinarId && prisma.webinar?.findFirst) {
        const w = await prisma.webinar.findFirst({
          where: {
            id: webinarId,
            webinarPlan: { consultantProfileId: consultantId },
          },
          select: {
            webinarPlan: { select: { collaborators: collabSelect } },
          },
        });
        rawCollabs = w?.webinarPlan?.collaborators;
      } else if (classId && prisma.class?.findFirst) {
        const c = await prisma.class.findFirst({
          where: {
            id: classId,
            classPlan: { consultantProfileId: consultantId },
          },
          select: {
            classPlan: { select: { collaborators: collabSelect } },
          },
        });
        rawCollabs = c?.classPlan?.collaborators;
      }
      if (Array.isArray(rawCollabs)) {
        for (const row of rawCollabs) {
          const cp = row.consultantProfile;
          const uid = cp?.userId ?? cp?.user?.id;
          if (!row.consultantProfileId || !uid) continue;
          coHostProfiles.push({
            consultantProfileId: row.consultantProfileId,
            userId: uid,
            scheduleType: cp?.scheduleType,
            availabilityWindowsWeekly: cp?.availabilityWindowsWeekly,
            availabilityWindowsCustom: cp?.availabilityWindowsCustom,
          });
        }
      }
    }

    // 2. Fetch all appointments to find allocated slots.
    //
    // The grid must answer occupancy the same way the allocator does, or it
    // paints cells green that every allocation mode then rejects. Both now
    // share buildConsultantOccupancyWhere.
    const slotsInWindow = {
      occurrences: {
        some: {
          // A tombstoned slot is not a booking — never paint it busy.
          // (No completionStatus filter: RESCHEDULED rows are a pending
          // reschedule's live hold and must still occupy the grid.)
          deletedAt: null,
          OR: [
            {
              startsAt: {
                gte: startDate,
                lt: endDate,
              },
            },
            {
              endsAt: {
                gt: startDate,
                lte: endDate,
              },
            },
            {
              startsAt: { lte: startDate },
              endsAt: { gte: endDate },
            },
          ],
        },
      },
    };

    // #1691 Item 4 — bound child occurrences in `include` to the requested
    // half-open window `[startDate, endDate)`. Any occurrence overlapping the
    // window satisfies `startsAt < endDate AND endsAt > startDate` (including
    // cross-boundary sessions that started before `startDate`), while
    // out-of-window occurrences on multi-month subscriptions/classes are not
    // fetched on every 60s poll.
    const windowOccurrencesWhere = {
      deletedAt: null,
      startsAt: { lt: endDate },
      endsAt: { gt: startDate },
    };

    const occupiedAppointmentWhere = {
      AND: [
        buildConsultantOccupancyWhere(consultantId, consultant.userId),
        slotsInWindow,
      ],
    };

    // The parent's status and payment window decide whether a hold is still
    // live; without them isOccupiedByLiveAppointment cannot drop an expired
    // APPROVED_PENDING_PAYMENT and the grid blanks out genuinely free time.
    const LIVE_OCCUPANCY_SELECT = {
      consultation: { select: { status: true, bookingSource: true } },
      subscription: { select: { status: true, bookingSource: true } },
      payment: { select: { expiresAt: true, paymentStatus: true } },
    } as const;

    // #997 Phase 2 — two separate queries (rather than one conditionally-built
    // `include`) so the PUBLIC path (majority of traffic — consultee/trials
    // browsing) never pays for the extra plan-title/participant-name joins.
    let rawSlotsOfAppointment: { id: string; startsAt: Date; endsAt: Date }[];
    let overlapMetaIndex: Map<number, OverlapAppointmentMeta[]> = new Map();
    let detailAppointments: AppointmentForOverlapMeta[] = [];
    const occupancyNow = new Date();

    // The consultee's own bookings — with ANY consultant — folded in below so
    // the grid and the allocator agree on what is free for BOTH parties.
    //
    // Deliberately a SECOND query rather than a third arm of the consultant's
    // OR: the detail branch attaches plan titles and participant names, and a
    // consultee's booking with a *different* consultant must read as busy and
    // nothing more (ADR 20). Merged, those rows would inherit that metadata.
    // A PrismaPromise does not execute until awaited, so it is handed to the
    // Promise.all below to run alongside the consultant query rather than
    // after it — separate query, same round-trip.
    const consulteeOccupancy = consulteeUserId
      ? prisma.appointment.findMany({
          where: {
            AND: [
              { OR: buildOccupiedAppointmentFilter() },
              { participants: { some: liveParticipant(consulteeUserId) } },
              slotsInWindow,
            ],
          },
          include: {
            occurrences: { where: windowOccurrencesWhere },
            ...LIVE_OCCUPANCY_SELECT,
          },
        })
      : Promise.resolve([]);

    // #1689 —ACCEPTED co-hosts' occupied appointments in `[startDate, endDate)`.
    const coHostOccupancy =
      coHostProfiles.length > 0
        ? prisma.appointment.findMany({
            where: {
              AND: [
                {
                  OR: coHostProfiles.map((ch) =>
                    buildConsultantOccupancyWhere(
                      ch.consultantProfileId,
                      ch.userId,
                    ),
                  ),
                },
                slotsInWindow,
              ],
            },
            include: {
              occurrences: { where: windowOccurrencesWhere },
              ...LIVE_OCCUPANCY_SELECT,
            },
          })
        : Promise.resolve([]);

    if (includeAppointmentDetails) {
      const [fetched] = await Promise.all([
        prisma.appointment.findMany({
          where: occupiedAppointmentWhere,
          include: {
            occurrences: { where: windowOccurrencesWhere },
            consultation: {
              select: {
                status: true,
                bookingSource: true,
                consultationPlan: { select: { title: true } },
                requestedBy: { select: { user: { select: { name: true } } } },
              },
            },
            subscription: {
              select: {
                status: true,
                bookingSource: true,
                subscriptionPlan: { select: { title: true } },
                requestedBy: { select: { user: { select: { name: true } } } },
              },
            },
            webinar: { select: { webinarPlan: { select: { title: true } } } },
            class: { select: { classPlan: { select: { title: true } } } },
            payment: { select: { expiresAt: true, paymentStatus: true } },
          },
        }),
        consulteeOccupancy,
        coHostOccupancy,
      ]);
      detailAppointments = fetched.filter((appt) =>
        isOccupiedByLiveAppointment(appt, occupancyNow),
      );
      rawSlotsOfAppointment = detailAppointments.flatMap(
        (appt) => appt.occurrences,
      );
      overlapMetaIndex = buildOverlapMetaIndex(detailAppointments);
    } else {
      const [appointments] = await Promise.all([
        prisma.appointment.findMany({
          where: occupiedAppointmentWhere,
          // Same tombstone + window exclusion as the detail branch above.
          include: {
            occurrences: { where: windowOccurrencesWhere },
            ...LIVE_OCCUPANCY_SELECT,
          },
        }),
        consulteeOccupancy,
        coHostOccupancy,
      ]);
      rawSlotsOfAppointment = appointments
        .filter((appt) => isOccupiedByLiveAppointment(appt, occupancyNow))
        .flatMap((appt) => appt.occurrences);
    }

    // No overlap metadata is attached to these: the consultant may see that the
    // time is taken, not what it is taken by (ADR 20). Already resolved by the
    // Promise.all above — this await does not add a round-trip.
    if (consulteeUserId || coHostProfiles.length > 0) {
      const [consulteeAppointments, coHostAppointments] = await Promise.all([
        consulteeOccupancy,
        coHostOccupancy,
      ]);

      const seen = new Set(rawSlotsOfAppointment.map((s) => s.id));
      for (const appt of [...consulteeAppointments, ...coHostAppointments]) {
        if (!isOccupiedByLiveAppointment(appt, occupancyNow)) continue;
        for (const slot of appt.occurrences) {
          if (!seen.has(slot.id)) {
            seen.add(slot.id);
            rawSlotsOfAppointment.push(slot);
          }
        }
      }
    }

    // Extract appointment slots using flatMap with defensive filtering
    // Defensive Programming: Filter out corrupt appointment slots
    const appointmentSlots: AppointmentSlot[] = rawSlotsOfAppointment
      .filter((slot) => {
        // Validate slot has required fields
        if (!slot.startsAt || !slot.endsAt) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: missing start or end time`,
          );
          return false;
        }

        // Validate slot times are valid dates
        const start = new Date(slot.startsAt);
        const end = new Date(slot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid appointment slots (allow legitimate overnight slots)
        if (!isValidOvernightSlot(start, end)) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: end time ${end.toISOString()} <= start time ${start.toISOString()} (not a valid overnight slot)`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
        // This likely indicates data corruption
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        if (end < tenYearsAgo) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()}) - possible data corruption`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
        // This likely indicates data corruption
        const tenYearsFromNow = new Date();
        tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
        if (start > tenYearsFromNow) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()}) - possible data corruption`,
          );
          return false;
        }

        // Defensive: Filter out slots with duration > 24 hours (likely data corruption)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Skipping appointment slot ${slot.id}: duration is > 24 hours (${durationHours.toFixed(1)}h) - possible data corruption`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }));

    // Convert to utility interfaces with defensive validation
    // Weekly slots now use Int (minutes since midnight UTC 0-1439) instead of DateTime
    const weeklySlots: WeeklySlot[] = (
      consultant.availabilityWindowsWeekly ?? []
    )
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (
          slot.startTimeUtc === null ||
          slot.startTimeUtc === undefined ||
          slot.endTimeUtc === null ||
          slot.endTimeUtc === undefined ||
          !slot.startDay
        ) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate values are in range (0-1439 minutes)
        if (
          slot.startTimeUtc < 0 ||
          slot.startTimeUtc > 1439 ||
          slot.endTimeUtc < 0 ||
          slot.endTimeUtc > 1439
        ) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: time values out of range (0-1439)`,
          );
          return false;
        }

        // For same-day slots, start must be before end
        if (
          slot.startDay === slot.endDay &&
          slot.startTimeUtc >= slot.endTimeUtc
        ) {
          console.warn(
            `❌ Filtering out invalid weekly slot ${slot.id}: startTimeUtc (${slot.startTimeUtc}) >= endTimeUtc (${slot.endTimeUtc}) on same day`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours = 1440 minutes)
        const durationMinutes =
          slot.startDay === slot.endDay
            ? slot.endTimeUtc - slot.startTimeUtc
            : 1440 - slot.startTimeUtc + slot.endTimeUtc;
        if (durationMinutes > 1440) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: duration > 24 hours (${(durationMinutes / 60).toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      // #1342 — the stored columns travel through as they are, including
      // utcOffsetMinutes: the generator derives each occurrence's UTC weekday
      // from the row's own frozen offset. Flattening the row onto a 1970
      // reference date threw that offset away and left the grid matching rows
      // against the viewer's weekday.
      .map((slot) => ({
        id: slot.id,
        startDay: slot.startDay,
        endDay: slot.endDay,
        startTimeUtc: slot.startTimeUtc,
        endTimeUtc: slot.endTimeUtc,
        utcOffsetMinutes: slot.utcOffsetMinutes,
      }));

    const customSlots: CustomSlot[] = (
      consultant.availabilityWindowsCustom ?? []
    )
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (!slot.startsAt || !slot.endsAt) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate dates are valid
        const start = new Date(slot.startsAt);
        const end = new Date(slot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid slots, but allow legitimate overnight slots
        if (!isValidOvernightSlot(slot.startsAt, slot.endsAt)) {
          console.warn(
            `❌ Filtering out invalid custom slot ${slot.id}: end time ${slot.endsAt.toISOString()} <= start time ${slot.startsAt.toISOString()}`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        if (end < tenYearsAgo) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()})`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
        const tenYearsFromNow = new Date();
        tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
        if (start > tenYearsFromNow) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()})`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: duration > 24 hours (${durationHours.toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }));

    // Apply schedule type filtering based on consultant's preference
    const filteredWeeklySlots =
      consultant.scheduleType === "WEEKLY" ? weeklySlots : [];
    const filteredCustomSlots =
      consultant.scheduleType === "CUSTOM" ? customSlots : [];

    // Process slots using the unified utility with filtered slots
    const slotsByDate: Record<string, SlotTimingWithOverlap[]> =
      processAvailabilitySlots(
        filteredWeeklySlots,
        filteredCustomSlots,
        appointmentSlots,
        startDate,
        endDate,
        timezone,
      );

    // #1689 — When allocating a webinar or class with ACCEPTED co-hosts whose
    // schedules were loaded, an unallocated slot is only available if every
    // co-host with schedule data also covers that 30-min atom.
    const coHostsWithSchedule = coHostProfiles.filter(
      (ch) =>
        ch.scheduleType &&
        (Array.isArray(ch.availabilityWindowsWeekly) ||
          Array.isArray(ch.availabilityWindowsCustom)),
    );
    if (coHostsWithSchedule.length > 0) {
      const isCoveredByCoHost = (
        slotStart: Date,
        slotEnd: Date,
        ch: (typeof coHostsWithSchedule)[number],
      ): boolean => {
        if (ch.scheduleType === "WEEKLY") {
          const day = slotStart.getUTCDay();
          const mins = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
          return (ch.availabilityWindowsWeekly ?? []).some((w) =>
            isMinuteWithinWeeklySlot(
              day,
              mins,
              30,
              w.startDay,
              w.startTimeUtc,
              w.endTimeUtc,
              w.utcOffsetMinutes ?? 0,
            ),
          );
        }
        return (ch.availabilityWindowsCustom ?? []).some(
          (c) =>
            new Date(c.startsAt) <= slotStart && new Date(c.endsAt) >= slotEnd,
        );
      };

      for (const dateKey of Object.keys(slotsByDate)) {
        slotsByDate[dateKey] = slotsByDate[dateKey].filter((slot) => {
          if (slot.isAllocated) return true;
          const s = new Date(slot.startsAt);
          const e = new Date(slot.endsAt);
          return coHostsWithSchedule.every((ch) => isCoveredByCoHost(s, e, ch));
        });
      }
    }

    // #997 Phase 2 & #1691 Item 3 — synthesize "orphan" booked cells for ALL
    // callers (not only `includeAppointmentDetails=true`): a booked appointment
    // slot whose availability row was edited/removed after booking (or a
    // consultee/co-host busy interval outside the host's published hours) must
    // still show as `isAllocated: true, bookingStatus: "fully-booked"`. Per-slot
    // `overlappingAppointments` tooltip metadata stays gated on
    // `includeAppointmentDetails` (ADR 20).
    const coveredStartsMs = new Set<number>();
    for (const dateKey of Object.keys(slotsByDate)) {
      for (const slot of slotsByDate[dateKey]) {
        const startMs = new Date(slot.startsAt).getTime();
        coveredStartsMs.add(startMs);
        if (includeAppointmentDetails) {
          const endMs = new Date(slot.endsAt).getTime();
          slot.overlappingAppointments = overlapMetaCandidatesFor(
            overlapMetaIndex,
            startMs,
            endMs,
          );
        }
      }
    }

    if (rawSlotsOfAppointment.length > 0) {
      const loc = makeLocalizer(timezone);
      for (const apptSlot of rawSlotsOfAppointment) {
        const start = new Date(apptSlot.startsAt);
        const end = new Date(apptSlot.endsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
        if (start < startDate || start >= endDate) continue;
        const startMs = start.getTime();
        if (coveredStartsMs.has(startMs)) continue;
        coveredStartsMs.add(startMs); // de-dupe overlapping appointment rows onto one cell

        const dateKey = loc.dateKey(start);
        const synthetic: SlotTimingWithOverlap = {
          slotId: `orphan-${startMs}`,
          dateInISO: start.toISOString(),
          dayOfWeek: dayMap[loc.dayIndex(start)],
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          availabilityWindowId: "",
          appointmentOccurrenceId: "",
          localStartTime: loc.timeP(start),
          localEndTime: loc.timeP(end),
          type: "CUSTOM",
          isAllocated: true,
          bookingStatus: "fully-booked",
          ...(includeAppointmentDetails
            ? {
                overlappingAppointments: overlapMetaCandidatesFor(
                  overlapMetaIndex,
                  startMs,
                  end.getTime(),
                ),
              }
            : {}),
        };
        (slotsByDate[dateKey] ||= []).push(synthetic);
      }

      // Re-sort days that received synthetic entries.
      for (const dateKey of Object.keys(slotsByDate)) {
        slotsByDate[dateKey].sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        );
      }
    }

    return NextResponse.json(
      { data: slotsByDate },
      {
        status: 200,
        headers: {
          "Cache-Control": GRID_CACHE_CONTROL,
          // #1319 PR 9 — what the next poll sends back as If-None-Match.
          ...(etag ? { ETag: etag } : {}),
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    console.error("Error fetching availability slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 },
    );
  }
}
