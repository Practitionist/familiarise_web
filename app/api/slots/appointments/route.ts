import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma } from "@prisma/client";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { getConsultantAppointments } from "@/lib/data/consultant-appointments";
import { computeWeeklyConfirmedCallCounts } from "@/lib/booking/weekly-call-counts";

export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type")?.toUpperCase();
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const userId = searchParams.get("userId");

  // Get specific event IDs for filtering
  const webinarId = searchParams.get("webinarId");
  const classId = searchParams.get("classId");
  const consultationId = searchParams.get("consultationId");
  const subscriptionId = searchParams.get("subscriptionId");

  // Get status for each appointment type
  const consultationStatus = searchParams
    .get("consultationStatus")
    ?.toUpperCase();
  const subscriptionStatus = searchParams
    .get("subscriptionStatus")
    ?.toUpperCase();
  const webinarStatus = searchParams.get("webinarStatus")?.toUpperCase();
  const classStatus = searchParams.get("classStatus")?.toUpperCase();

  // Non-privileged users must scope to their own data
  if (!isPrivileged(session.user.role)) {
    const hasOwnFilter =
      (consultantProfileId &&
        consultantProfileId === session.user.consultantProfileId) ||
      (consulteeProfileId &&
        consulteeProfileId === session.user.consulteeProfileId) ||
      (userId && userId === session.user.id);
    if (!hasOwnFilter) {
      return NextResponse.json(
        { error: "Forbidden: must filter by your own profile" },
        { status: 403 },
      );
    }
  }

  // Validate appointment type
  if (
    type &&
    !Object.values(AppointmentsType).includes(type as AppointmentsType)
  ) {
    return NextResponse.json(
      { error: "Invalid appointment type" },
      { status: 400 },
    );
  }

  // Validate statuses — consultation/subscription use AppointmentStatus enum,
  // webinar/class use their own event lifecycle statuses
  const validRequestStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
    "SCHEDULED",
    "COMPLETED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
  ];
  const validEventStatuses = [
    "SCHEDULED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
  ];
  if (consultationStatus && !validRequestStatuses.includes(consultationStatus)) {
    return NextResponse.json(
      { error: "Invalid consultation status" },
      { status: 400 },
    );
  }
  if (subscriptionStatus && !validRequestStatuses.includes(subscriptionStatus)) {
    return NextResponse.json(
      { error: "Invalid subscription status" },
      { status: 400 },
    );
  }
  if (webinarStatus && !validEventStatuses.includes(webinarStatus)) {
    return NextResponse.json(
      { error: "Invalid webinar status" },
      { status: 400 },
    );
  }
  if (classStatus && !validEventStatuses.includes(classStatus)) {
    return NextResponse.json(
      { error: "Invalid class status" },
      { status: 400 },
    );
  }

  // #674 personal-vs-org scope filter. The leak this closes: a consultant
  // who hosts under Acme + Zeta would see appointments from both orgs in
  // a single "Appointments" tab regardless of which org context the
  // dashboard had selected. Filter via the denormalized
  // Appointment.organizationId column populated by the #674 backfill.
  const callerMembershipsForScope = await prisma.membership.findMany({
    where: { userId: session.user.id, status: "ACTIVE" },
    select: { organizationId: true, status: true },
  });
  const scopeResolution = resolveOrgScope({
    raw: searchParams.get("orgScope"),
    memberships: callerMembershipsForScope,
    userRole: session.user.role,
    // Self-scoped: non-admin callers are already locked to their own
    // profileId via `hasOwnFilter` above, so `?orgScope=all` here just
    // means "all of MY data" — safe for any role.
    allowAllForOwner: true,
  });
  if (!scopeResolution.ok) {
    return NextResponse.json(
      { error: scopeResolution.message, code: scopeResolution.code },
      { status: scopeResolution.status },
    );
  }
  const apptOrgFilter: Partial<Prisma.AppointmentWhereInput> =
    scopeResolution.scope.kind === "personal"
      ? { organizationId: null }
      : scopeResolution.scope.kind === "org"
        ? { organizationId: scopeResolution.scope.orgId }
        : {};

  try {
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const appointments = await getConsultantAppointments({
      type: type as AppointmentsType | undefined,
      consultantProfileId,
      consulteeProfileId,
      userId,
      statuses: {
        consultation: consultationStatus || undefined,
        subscription: subscriptionStatus || undefined,
        webinar: webinarStatus || undefined,
        class: classStatus || undefined,
      },
      startDate,
      endDate,
      eventIds: {
        webinarId,
        classId,
        consultationId,
        subscriptionId,
      },
      orgScopeFilter: apptOrgFilter,
    });

    // #997 Phase 3 — opt-in aggregate, only computed when the caller scopes
    // to a single subscription and states its per-call slot count (both
    // already known client-side from the plan config — no extra DB read).
    const slotsPerCallParam = searchParams.get("slotsPerCall");
    const slotsPerCall = slotsPerCallParam
      ? parseInt(slotsPerCallParam, 10)
      : NaN;
    const weeklyConfirmedCallCounts =
      subscriptionId && Number.isFinite(slotsPerCall) && slotsPerCall > 0
        ? computeWeeklyConfirmedCallCounts(
            appointments,
            subscriptionId,
            slotsPerCall,
          )
        : undefined;

    return NextResponse.json({
      data: appointments,
      ...(weeklyConfirmedCallCounts ? { weeklyConfirmedCallCounts } : {}),
    });
  } catch (error) {
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching appointments" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // Only privileged users (admin/staff) can directly create appointments.
  // Normal booking goes through the checkout flow which has its own validation.
  if (!isPrivileged(session.user.role)) {
    return NextResponse.json(
      { error: "Forbidden: appointment creation requires admin/staff role" },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const { appointmentType, slotsOfAppointment, ...appointmentData } = body;

    if (!appointmentType || !slotsOfAppointment?.createMany?.data?.length) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const data: Prisma.AppointmentCreateInput = {
      appointmentType,
      ...appointmentData,
      slotsOfAppointment: {
        create: slotsOfAppointment.createMany.data.map(
          (slot: {
            startsAt: string;
            endsAt: string;
            type?: "WEEKLY" | "CUSTOM";
          }) => ({
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
            type: slot.type || "WEEKLY", // Default to WEEKLY if not specified
          }),
        ),
      },
    };

    const newAppointment = await prisma.appointment.create({
      data,
      include: {
        slotsOfAppointment: {
          include: {
            user: true,
          },
        },
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: true,
              },
            },
          },
        },
        subscription: {
          select: {
            id: true,
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: true,
              },
            },
            schedulingPeriodStartsAt: true,
            schedulingPeriodEndsAt: true,
            status: true,
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: newAppointment }, { status: 201 });
  } catch (error) {
    console.error("Error creating appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the appointment" },
      { status: 500 },
    );
  }
}
