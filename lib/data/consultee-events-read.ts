/**
 * Shared read for the consultee events surface. #890
 *
 * Single source of truth for the 5-booking-type union the consultee
 * dashboard Home + Appointments views render. Both the API route
 * (`/api/dashboard/consultee/[consulteeId]/events`) and the consultee
 * home server page call this directly so SSR hydration and the client
 * `useQuery` resolve byte-identical payloads — the route wraps it in
 * `{ data, success }`, the prefetch returns it raw (matching
 * `fetchWithErrorHandling`'s `json.data` unwrap).
 *
 * Auth + `?orgScope=` resolution stay in the route; this function takes
 * an already-resolved `Scope` so it carries no request/session coupling
 * and is callable from a Server Component.
 */

import prisma from "@/lib/prisma";
import { WaitlistStatus, type Prisma } from "@prisma/client";
import type { Scope } from "@/lib/api/scope/parse";
import { toPlain } from "@/lib/data/serialize";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

/** Thrown when the consulteeId has no profile — route maps to 404. */
export class ConsulteeProfileNotFoundError extends Error {
  constructor(consulteeId: string) {
    super(`Consultee profile not found: ${consulteeId}`);
    this.name = "ConsulteeProfileNotFoundError";
  }
}

/**
 * Read the consultee's event union for a resolved scope. Returns the
 * inner payload shape (NOT wrapped in `{ data, success }`).
 */
export async function readConsulteeEvents(
  consulteeId: string,
  scope: Scope,
): Promise<TConsulteeEventsResponse> {
  // Get the userId from consultee profile to check waitlist memberships
  const consulteeProfile = await prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  });

  if (!consulteeProfile) {
    throw new ConsulteeProfileNotFoundError(consulteeId);
  }

  const userId = consulteeProfile.userId;

  // Build per-resource org filters. The 5 booking models attach to
  // org context differently:
  //   - Consultation / Webinar (1:1 appointment): filter via
  //     `appointment.is.organizationId`
  //   - Subscription / Class (1:many appointments): filter via
  //     `appointments.some.organizationId` so the parent surfaces if
  //     ANY child appointment matches the scope
  //   - TrialSession: filter directly via `organizationId`
  const oneApptOrgWhere: Prisma.AppointmentWhereInput | undefined =
    scope.kind === "personal"
      ? { organizationId: null }
      : scope.kind === "org"
        ? { organizationId: scope.orgId }
        : undefined;
  const manyApptOrgWhere: Prisma.AppointmentWhereInput | undefined =
    oneApptOrgWhere;
  const trialOrgWhere: Prisma.TrialSessionWhereInput | undefined =
    scope.kind === "personal"
      ? { organizationId: null }
      : scope.kind === "org"
        ? { organizationId: scope.orgId }
        : undefined;

  // TTFB bound: cap each booking query to recent-or-future rows. The
  // consultee Home calendar lets users page backward month-by-month, so
  // the lower bound is 1 year (not 90 days) to keep that browse window
  // intact while a multi-year veteran no longer pulls full history.
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const EVENTS_TAKE = 200;

  // PERFORMANCE FIX: Use direct Prisma queries instead of internal HTTP fetches
  // This avoids network overhead and reduces response time from 11+ seconds to <1 second
  const [consultations, subscriptions, webinars, classes, trials] =
    await Promise.all([
      prisma.consultation.findMany({
        where: {
          requestedById: consulteeId,
          // Org scope only — NO slot requirement. The Appointments → Upcoming
          // view renders slot-less PENDING bookings (pending-payment CTA), so
          // requiring an in-window slot would hide them. take:EVENTS_TAKE bounds
          // the row count instead. #887
          ...(oneApptOrgWhere && { appointment: { is: oneApptOrgWhere } }),
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
      prisma.subscription.findMany({
        where: {
          requestedById: consulteeId,
          // Org scope only — NO slot requirement (see consultation above);
          // take:EVENTS_TAKE bounds the row count without hiding slot-less
          // PENDING subscriptions. #887
          ...(manyApptOrgWhere && { appointments: { some: manyApptOrgWhere } }),
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true },
                  },
                },
              },
              payment: true,
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Webinars: User registered via appointment slots OR waitlisted
      prisma.webinar.findMany({
        where: {
          OR: [
            {
              appointment: {
                slotsOfAppointment: {
                  // TTFB bound: the registered-via-slot branch only —
                  // the user must own a slot AND it must be in-window.
                  some: {
                    user: { some: { id: userId } },
                    startsAt: { gte: since },
                  },
                },
                ...(oneApptOrgWhere ?? {}),
              },
            },
            {
              // Waitlist branch left unbounded by date — a waitlisted
              // entry may have no scheduled slot yet.
              waitlist: {
                some: {
                  userId,
                  status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED, WaitlistStatus.BOOKED] },
                },
              },
            },
          ],
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true },
                  },
                },
              },
              payment: true,
            },
          },
          waitlist: {
            where: { userId },
          },
        },
        orderBy: { createdAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Classes: User registered via appointment slots OR waitlisted
      prisma.class.findMany({
        where: {
          OR: [
            {
              appointments: {
                some: {
                  slotsOfAppointment: {
                    // TTFB bound: registered-via-slot branch only — the
                    // user must own a slot AND it must be in-window.
                    some: {
                      user: { some: { id: userId } },
                      startsAt: { gte: since },
                    },
                  },
                  ...(manyApptOrgWhere ?? {}),
                },
              },
            },
            {
              // Waitlist branch left unbounded by date — a waitlisted
              // entry may have no scheduled slot yet.
              waitlist: {
                some: {
                  userId,
                  status: { in: [WaitlistStatus.WAITING, WaitlistStatus.NOTIFIED, WaitlistStatus.BOOKED] },
                },
              },
            },
          ],
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
              collaborators: {
                where: { status: "ACCEPTED" },
                include: {
                  consultantProfile: {
                    include: {
                      user: {
                        select: {
                          id: true,
                          name: true,
                          image: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  meetingSession: {
                    select: { id: true, endedAt: true },
                  },
                },
              },
              payment: true,
            },
          },
          waitlist: {
            where: { userId },
          },
        },
        orderBy: { createdAt: "desc" },
        take: EVENTS_TAKE,
      }),
      // Trial sessions: Free trials requested by the consultee
      prisma.trialSession.findMany({
        where: {
          consulteeProfileId: consulteeId,
          ...(trialOrgWhere ?? {}),
          // TTFB bound: trials may be PENDING with no appointment/slot
          // yet, so bound by requestedAt (the orderBy field) rather than
          // slot start to avoid dropping recent slot-less trials.
          requestedAt: { gte: since },
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                orderBy: { startsAt: "asc" },
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      image: true,
                    },
                  },
                  meetingSession: {
                    select: { id: true, endedAt: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        take: EVENTS_TAKE,
      }),
    ]);

  // toPlain — the booking rows include money-extended plan/payment
  // relations (#780/#781 result extensions) that carry Prisma's inspect
  // symbol; they must be plainified before crossing the RSC→Client
  // HydrationBoundary. The route path (NextResponse.json) drops symbols
  // anyway, so this only matters for the SSR prefetch. Preserves Dates.
  return toPlain({
    consultations,
    subscriptions,
    webinars,
    classes,
    trials,
  }) as unknown as TConsulteeEventsResponse;
}
