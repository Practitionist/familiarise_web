import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  PROFILE_WITH_USER_SELECT,
  APPOINTMENT_LIST_SELECT,
} from "@/lib/booking/list-selects";
import { AppointmentStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { transitionConsultationRequest } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { searchParams } = new URL(request.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const status = searchParams.get("status") as AppointmentStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    const whereClause: Record<string, unknown> = {};

    // Authorization: filter by ownership for non-privileged users.
    // `?? "__none__"` (the participants-route idiom) is load-bearing: a
    // session with a missing profile id would otherwise put `undefined`
    // into the where clause, which Prisma IGNORES — silently dropping the
    // ownership filter and serving every consultant's consultations.
    if (!isPrivileged(session.user.role)) {
      if (session.user.role === "CONSULTANT") {
        // Consultants can only see their own consultations. Filter on the
        // plan's scalar FK (indexed) instead of joining consultantProfile.
        whereClause.consultationPlan = {
          consultantProfileId: session.user.consultantProfileId ?? "__none__",
        };
      } else if (session.user.role === "CONSULTEE") {
        // Consultees can only see their own consultations
        whereClause.requestedById = session.user.consulteeProfileId ?? "__none__";
      } else {
        // Unknown role - deny access
        return forbiddenResponse("Access denied");
      }
    } else {
      // Privileged users can filter by any profile
      if (consultantProfileId) {
        whereClause.consultationPlan = {
          consultantProfile: {
            id: consultantProfileId,
          },
        };
      }

      if (consulteeProfileId) {
        whereClause.requestedById = consulteeProfileId;
      }
    }

    if (status) {
      whereClause.status = status;
    }

    // Personal-vs-org scope filter (same mechanism as /api/slots/appointments:
    // the denormalized Appointment.organizationId). ADDITIVE: when the param
    // is absent, behavior is unchanged (unfiltered union) so existing callers
    // keep seeing everything. A consultation with no Appointment row is
    // definitionally not org-funded, so it counts as personal.
    const rawOrgScope = searchParams.get("orgScope");
    if (rawOrgScope) {
      const memberships = await prisma.membership.findMany({
        where: { userId: session.user.id, status: "ACTIVE" },
        select: { organizationId: true, status: true },
      });
      const scopeResolution = resolveOrgScope({
        raw: rawOrgScope,
        memberships,
        userRole: session.user.role,
        // Self-scoped: the ownership filter above already locks non-admin
        // callers to their own rows, so "all" just means "all of MY data".
        allowAllForOwner: true,
      });
      if (!scopeResolution.ok) {
        return NextResponse.json(
          { error: scopeResolution.message, code: scopeResolution.code },
          { status: scopeResolution.status },
        );
      }
      if (scopeResolution.scope.kind === "personal") {
        whereClause.OR = [
          { appointment: null },
          { appointment: { organizationId: null } },
        ];
      } else if (scopeResolution.scope.kind === "org") {
        whereClause.appointment = {
          organizationId: scopeResolution.scope.orgId,
        };
      }
      // kind === "all": no additional filter
    }

    const [consultations, total] = await Promise.all([
      // #997 Phase 0 — narrow SELECT (see subscriptions route for rationale).
      prisma.consultation.findMany({
        where: whereClause,
        select: {
          id: true,
          status: true,
          requestedAt: true,
          bookingSource: true,
          consultationPlan: {
            select: {
              id: true,
              title: true,
              durationInHours: true,
              consultantProfileId: true,
              consultantProfile: PROFILE_WITH_USER_SELECT,
            },
          },
          requestedBy: PROFILE_WITH_USER_SELECT,
          appointment: APPOINTMENT_LIST_SELECT,
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.consultation.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: consultations,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error fetching consultations:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultations" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // #831 — event mutations previously had no limiter
    const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (rl) return rl;

    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (!Object.values(AppointmentStatus).includes(status as AppointmentStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // Verify ownership before allowing status change
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    // Check authorization: must be a participant or privileged
    const isConsultant =
      !!existingConsultation.consultationPlan?.consultantProfile?.id &&
      existingConsultation.consultationPlan.consultantProfile.id ===
        session.user.consultantProfileId;
    const isConsultee =
      !!existingConsultation.requestedById &&
      existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    // #836 — allowed-from guard rides the WHERE; updateMany returns no row,
    // so re-read for the heavy include.
    await prisma.$transaction((tx) =>
      transitionConsultationRequest(tx, { where: { id }, to: status }),
    );
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: { select: { id: true, name: true, email: true, image: true, role: true, phone: true } },
              },
            },
            payment: { select: { id: true, paymentStatus: true, amount: true, currency: true } },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}
