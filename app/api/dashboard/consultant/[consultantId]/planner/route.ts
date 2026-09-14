import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { Prisma } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";

// =============================================================================
// Prisma Query Types - Derived from actual query shape for type safety
// =============================================================================

const webinarInclude = {
  webinarPlan: {
    include: {
      consultantProfile: true,
      topics: true,
    },
  },
  appointment: {
    include: {
      // #1554 — the seat count is the live roster; ids only, so the planner
      // payload never carries a User row per attendee.
      participants: {
        where: liveParticipant(),
        select: { userId: true },
      },
      occurrences: {
        include: {
          // #1061 — without this the planner cannot tell that the host has
          // already ended the call, so its Join gate could only ever expire on
          // the clock. Two columns per row.
          meeting: {
            select: { id: true, endedAt: true, endedReason: true },
          },
        },
      },
    },
  },
} satisfies Prisma.WebinarInclude;

/**
 * How far either side of now a class slot row has to be to matter to the
 * planner. The only reader of these rows is the Join affordance, and a run
 * that is joinable now cannot have started, or end, outside a day of now — so
 * the bound drops rows the join path could never pick while keeping every run
 * it can pick whole. Truncating a run mid-way would re-split the room #1061
 * just closed, which is why the window is a day and not the join window.
 *
 * The card's displayed date does not read these rows any more: it reads
 * `firstSessionAt`, a separate unwindowed lookup, because a class whose
 * sessions all fall outside this window arrives here with zero slots (#1346).
 */
const PLANNER_COHORT_SLOT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded by `now`, so this is a factory rather than the module-level constant
 * the webinar side can be.
 */
const cohortInclude = (now: Date) =>
  ({
    cohortPlan: {
      include: {
        consultantProfile: true,
        topics: true,
        cohortContents: {
          orderBy: {
            order: "asc" as const,
          },
        },
      },
    },
    appointment: {
      include: {
        // #1080 — the planner derives a class's joinable session from these
        // rows, and `appointments: true` returned none of them, so every class
        // reported "No joinable session found" at every hour of every day.
        // Only the fields the join path reads: this route trims deliberately,
        // and the attendee `user` rows the webinar side carries are not read
        // here (the class participant count has its own batched query).
        // `meeting` is not optional — without it `getSessionJoinState`
        // can only expire on the clock and never sees a host-ended call, the
        // same reason `webinarInclude` selects it.
        occurrences: {
          where: {
            startsAt: {
              gte: new Date(now.getTime() - PLANNER_COHORT_SLOT_WINDOW_MS),
              lte: new Date(now.getTime() + PLANNER_COHORT_SLOT_WINDOW_MS),
            },
          },
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            isTentative: true,
            completionStatus: true,
            meeting: {
              select: { id: true, endedAt: true, endedReason: true },
            },
          },
        },
      },
    },
  }) satisfies Prisma.CohortInclude;

// Derive types from the include objects via the extended client — raw
// GetPayload would re-introduce bigint money fields (#780).
type PlannerWebinar = Prisma.Result<
  typeof prisma.webinar,
  { include: typeof webinarInclude },
  "findFirstOrThrow"
>;
type PlannerCohort = Prisma.Result<
  typeof prisma.cohort,
  { include: ReturnType<typeof cohortInclude> },
  "findFirstOrThrow"
>;

// Response types with discriminators and role annotations
type WebinarEvent = PlannerWebinar & {
  type: "webinar";
  collaboratorRole: string;
  isCollaborated: boolean;
};
type CohortEvent = PlannerCohort & {
  type: "class";
  collaboratorRole: string;
  isCollaborated: boolean;
  // #1346 — cohortInclude's slots are windowed to ±24h of now for the Join
  // affordance, so a class whose sessions fall outside that day arrives with
  // zero slots here; the card's date comes from this field instead.
  firstSessionAt: string | null;
};

interface PlannerData {
  webinars: WebinarEvent[];
  cohorts: CohortEvent[];
  participantCounts: Record<string, number>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Webinar participant counts computed from the ALREADY-FETCHED webinar rows
 * (webinarInclude carries appointment.participants) — the old
 * helper re-queried the same rows from Postgres a second time per request.
 * FIX #556 semantics preserved: live seats only, deduplicated per webinar,
 * consultant host excluded.
 */
function countWebinarParticipants(
  webinars: Array<{
    id: string;
    appointment: { participants: Array<{ userId: string }> } | null;
  }>,
  excludeConsultantUserId?: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const webinar of webinars) {
    const uniqueUserIds = new Set<string>();
    for (const seat of webinar.appointment?.participants || []) {
      if (seat.userId !== excludeConsultantUserId) {
        uniqueUserIds.add(seat.userId);
      }
    }
    counts[webinar.id] = uniqueUserIds.size;
  }
  return counts;
}

/**
 * Class participant counts still need their one batched query — cohortInclude
 * now carries slot rows (#1080) but not the attendees on them, and it is
 * bounded to a day either side of now, so the user ids are not in memory and
 * counting from them would under-report. FIX #142: batched, never N+1.
 */
async function getCohortParticipantCounts(
  cohortIds: string[],
  excludeConsultantUserId?: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  if (cohortIds.length > 0) {
    const cohortCounts = await prisma.cohort.findMany({
      where: { id: { in: cohortIds } },
      select: {
        id: true,
        appointment: {
          select: {
            participants: {
              where: liveParticipant(),
              select: { userId: true },
            },
          },
        },
      },
    });

    for (const cohortEvent of cohortCounts) {
      // Unique users on the class's one wrapper (#1554).
      // FIX #556: Exclude the consultant host from participant count
      const uniqueUserIds = new Set<string>();

      for (const seat of cohortEvent.appointment?.participants ?? []) {
        if (seat.userId !== excludeConsultantUserId) {
          uniqueUserIds.add(seat.userId);
        }
      }

      counts[cohortEvent.id] = uniqueUserIds.size;
    }
  }

  return counts;
}

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consultantId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consultantProfileId !== consultantId
    ) {
      return forbiddenResponse("You can only access your own planner");
    }

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // B1-personal-retrofit: parse + authorize ?orgScope=. Filter applies
    // to the appointment.organizationId attached to each Webinar/Class.
    // Plans without bookings yet are NOT filtered (the planner shows
    // owned + collaborated plans regardless of whether anyone has
    // booked them).
    const url = new URL(request.url);
    const consultantUser = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { userId: true },
    });
    const callerMemberships = consultantUser
      ? await prisma.membership.findMany({
          where: { userId: consultantUser.userId, status: "ACTIVE" },
          select: { organizationId: true, status: true, role: true },
        })
      : [];
    const scopeResolution = resolveOrgScope({
      raw: url.searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped consultant endpoint.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    // For Webinar (1:1 appointment) — `appointment.is.organizationId`.
    // For Class (1:many appointments) — `appointments.some.organizationId`.
    //
    // Personal scope: include events that have NO appointment yet (unbooked)
    // OR have an appointment with organizationId=null. Using only
    // `{ appointment: { is: { organizationId: null } } }` would exclude
    // freshly created unbooked events, hiding them from the consultant's
    // own inventory view. Issue: #732 (planner inventory vs booking-history
    // semantics — flagged in the May 2026 readiness audit).
    // `orgMember` pins an org exactly as `org` does — see scopeOrgId.
    const plannerOrgId = scopeOrgId(scopeResolution.scope);
    const webinarApptOrg: Prisma.WebinarWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointment: { is: null } },
              { appointment: { is: { organizationId: null } } },
            ],
          }
        : plannerOrgId
          ? {
              appointment: {
                is: { organizationId: plannerOrgId },
              },
            }
          : undefined;
    const cohortApptOrg: Prisma.CohortWhereInput | undefined =
      scopeResolution.scope.kind === "personal"
        ? {
            OR: [
              { appointment: null },
              { appointment: { organizationId: null } },
            ],
          }
        : plannerOrgId
          ? {
              appointment: { organizationId: plannerOrgId },
            }
          : undefined;

    // Read once, so the owned and collaborated class queries bound their slot
    // rows to the same instant and a session cannot straddle the two.
    const cohortSlotsAround = cohortInclude(new Date());

    // Fetch owned plans, collaborated plans, and collaborator roles in parallel
    const [
      ownedWebinarsRaw,
      ownedCohortsRaw,
      collabWebinarsRaw,
      collabCohortsRaw,
      collabRoles,
    ] = await Promise.all([
      // Owned plans
      prisma.webinar.findMany({
        where: {
          webinarPlan: { consultantProfileId: consultantId },
          ...(webinarApptOrg ?? {}),
        },
        include: webinarInclude,
      }),
      prisma.cohort.findMany({
        where: {
          cohortPlan: { consultantProfileId: consultantId },
          ...(cohortApptOrg ?? {}),
        },
        include: cohortSlotsAround,
      }),
      // Collaborated plans (only ACCEPTED)
      prisma.webinar.findMany({
        where: {
          webinarPlan: {
            collaborators: {
              some: { consultantProfileId: consultantId, status: "ACCEPTED" },
            },
          },
          ...(webinarApptOrg ?? {}),
        },
        include: webinarInclude,
      }),
      prisma.cohort.findMany({
        where: {
          cohortPlan: {
            collaborators: {
              some: { consultantProfileId: consultantId, status: "ACCEPTED" },
            },
          },
          ...(cohortApptOrg ?? {}),
        },
        include: cohortSlotsAround,
      }),
      // Collaborator role lookups (#784 — one merged model for both plan types)
      prisma.collaborator.findMany({
        where: { consultantProfileId: consultantId, status: "ACCEPTED" },
        select: { webinarPlanId: true, cohortPlanId: true, role: true },
      }),
    ]);

    // Build role lookup maps — exactly one plan FK is set per record (#784)
    const webinarRoleMap: Record<string, string> = {};
    const cohortRoleMap: Record<string, string> = {};
    for (const c of collabRoles) {
      if (c.webinarPlanId) webinarRoleMap[c.webinarPlanId] = c.role;
      else if (c.cohortPlanId) cohortRoleMap[c.cohortPlanId] = c.role;
    }

    // Collect owned IDs for deduplication
    const ownedWebinarIds = new Set(ownedWebinarsRaw.map((w) => w.id));
    const ownedCohortIds = new Set(ownedCohortsRaw.map((c) => c.id));

    // Filter out any collaborated plans that are also owned (defensive)
    const uniqueCollabWebinars = collabWebinarsRaw.filter(
      (w) => !ownedWebinarIds.has(w.id),
    );
    const uniqueCollabCohorts = collabCohortsRaw.filter(
      (c) => !ownedCohortIds.has(c.id),
    );

    // Transform topics and annotate with roles
    const webinars: WebinarEvent[] = [
      ...ownedWebinarsRaw.map((w) => ({
        ...transformNestedPlanTopics(w, "webinarPlan"),
        type: "webinar" as const,
        collaboratorRole: "HOST",
        isCollaborated: false,
      })),
      ...uniqueCollabWebinars.map((w) => ({
        ...transformNestedPlanTopics(w, "webinarPlan"),
        type: "webinar" as const,
        collaboratorRole: webinarRoleMap[w.webinarPlanId] || "COLLABORATOR",
        isCollaborated: true,
      })),
    ];

    const cohorts: CohortEvent[] = [
      ...ownedCohortsRaw.map((c) => ({
        ...transformNestedPlanTopics(c, "cohortPlan"),
        type: "class" as const,
        collaboratorRole: "HOST",
        isCollaborated: false,
        firstSessionAt: null,
      })),
      ...uniqueCollabCohorts.map((c) => ({
        ...transformNestedPlanTopics(c, "cohortPlan"),
        type: "class" as const,
        collaboratorRole: cohortRoleMap[c.cohortPlanId] || "COLLABORATOR",
        isCollaborated: true,
        firstSessionAt: null,
      })),
    ];

    // #1346 — cohortInclude's slot window drops rows outside ±24h of now, so
    // the earliest session must be read separately, unwindowed, in one
    // batched query rather than per-card.
    const cohortAppointmentIds = cohorts.flatMap((c) =>
      c.appointment ? [c.appointment.id] : [],
    );
    if (cohortAppointmentIds.length > 0) {
      const earliestSlots = await prisma.appointmentOccurrence.groupBy({
        by: ["appointmentId"],
        where: {
          appointmentId: { in: cohortAppointmentIds },
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        },
        _min: { startsAt: true },
      });
      const appointmentToCohortId: Record<string, string> = {};
      for (const c of cohorts) {
        if (c.appointment) appointmentToCohortId[c.appointment.id] = c.id;
      }
      const earliestByCohortId: Record<string, Date> = {};
      for (const row of earliestSlots) {
        const cohortId = appointmentToCohortId[row.appointmentId];
        const startsAt = row._min.startsAt;
        if (!cohortId || !startsAt) continue;
        const existing = earliestByCohortId[cohortId];
        if (!existing || startsAt < existing) {
          earliestByCohortId[cohortId] = startsAt;
        }
      }
      for (const c of cohorts) {
        c.firstSessionAt = earliestByCohortId[c.id]?.toISOString() ?? null;
      }
    }

    // Participant counts for all events (owned + collaborated).
    // FIX #556: the consultant's own userId is excluded — reuse the
    // consultantUser already fetched for org-scope resolution above (the
    // old code re-fetched the identical row here).
    const cohortIds = cohorts.map((c) => c.id);
    const participantCounts = {
      ...countWebinarParticipants(webinars, consultantUser?.userId),
      ...(await getCohortParticipantCounts(cohortIds, consultantUser?.userId)),
    };

    const plannerData: PlannerData = {
      webinars,
      cohorts,
      participantCounts,
    };

    return NextResponse.json({
      data: plannerData,
      success: true,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching planner data:", error);
    return NextResponse.json(
      { error: "Failed to fetch planner data" },
      { status: 500 },
    );
  }
}
