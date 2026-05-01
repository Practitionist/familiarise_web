import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { WaitlistStatus, type Prisma } from "@prisma/client";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope, type Scope } from "@/lib/api/scope/parse";

/**
 * Personal "all my bookings" widget endpoint. Returns the union of 5
 * booking types (consultations, subscriptions, webinars, classes,
 * trials) flattened for the consultee dashboard. Pre-existing surface
 * — keep using this for the consultee's primary appointments view.
 *
 * NOT to be confused with `/api/appointments` (#674 / B1-hybrid),
 * which is the paginated scope-aware list used by the new org
 * dashboards. See `prompts/enterprise-test-prompt.md` §10 for the
 * tradeoff matrix.
 *
 * `?orgScope=<orgId|personal|all>` — added in B1-personal-retrofit so
 * the consultee dashboard can toggle between personal-only / a
 * specific org's bookings / everything (admin-only). Default is
 * `personal` for backwards compatibility (previous callers omit the
 * param and get the same data they always have, since pre-B1 every
 * row was implicitly personal). Cross-tenant scope guard fires here
 * just like in `/api/appointments` — the caller must be a member of
 * the requested org or hold ADMIN/STAFF.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own events");
    }

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    // Get the userId from consultee profile to check waitlist memberships
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const userId = consulteeProfile.userId;

    // B1-personal-retrofit: parse + authorize ?orgScope=. Default
    // `personal` keeps every existing caller working without changes.
    const url = new URL(request.url);
    const callerMemberships = await prisma.membership.findMany({
      where: { userId, status: "ACTIVE" },
      select: { organizationId: true, status: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: url.searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }
    const scope: Scope = scopeResolution.scope;

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

    // PERFORMANCE FIX: Use direct Prisma queries instead of internal HTTP fetches
    // This avoids network overhead and reduces response time from 11+ seconds to <1 second
    const [consultations, subscriptions, webinars, classes, trials] =
      await Promise.all([
        prisma.consultation.findMany({
          where: {
            requestedById: consulteeId,
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
        }),
        prisma.subscription.findMany({
          where: {
            requestedById: consulteeId,
            ...(manyApptOrgWhere && {
              appointments: { some: manyApptOrgWhere },
            }),
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
        }),
        // Webinars: User registered via appointment slots OR waitlisted
        prisma.webinar.findMany({
          where: {
            OR: [
              {
                appointment: {
                  slotsOfAppointment: {
                    some: { user: { some: { id: userId } } },
                  },
                  ...(oneApptOrgWhere ?? {}),
                },
              },
              {
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
        }),
        // Classes: User registered via appointment slots OR waitlisted
        prisma.class.findMany({
          where: {
            OR: [
              {
                appointments: {
                  some: {
                    slotsOfAppointment: {
                      some: { user: { some: { id: userId } } },
                    },
                    ...(manyApptOrgWhere ?? {}),
                  },
                },
              },
              {
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
        }),
        // Trial sessions: Free trials requested by the consultee
        prisma.trialSession.findMany({
          where: {
            consulteeProfileId: consulteeId,
            ...(trialOrgWhere ?? {}),
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
        }),
      ]);

    return NextResponse.json({
      data: {
        consultations,
        subscriptions,
        webinars,
        classes,
        trials,
      },
      success: true,
    });
  } catch (error) {
    console.error("Error fetching consultee events:", error);
    return NextResponse.json(
      { error: "Failed to fetch consultee events" },
      { status: 500 },
    );
  }
}
