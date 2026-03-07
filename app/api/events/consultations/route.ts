import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
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
    const status = searchParams.get("status") as RequestStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    const whereClause: Record<string, unknown> = {};

    // Authorization: filter by ownership for non-privileged users
    if (!isPrivileged(session.user.role)) {
      if (session.user.role === "CONSULTANT") {
        // Consultants can only see their own consultations
        whereClause.consultationPlan = {
          consultantProfile: {
            id: session.user.consultantProfileId,
          },
        };
      } else if (session.user.role === "CONSULTEE") {
        // Consultees can only see their own consultations
        whereClause.requestedById = session.user.consulteeProfileId;
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
      whereClause.requestStatus = status;
    }

    const [consultations, total] = await Promise.all([
      prisma.consultation.findMany({
        where: whereClause,
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
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
                orderBy: {
                  startsAt: "asc",
                },
              },
              payment: true,
            },
          },
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

    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (!Object.values(RequestStatus).includes(status as RequestStatus)) {
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
      !!existingConsultation.requestedById && existingConsultation.requestedById === session.user.consulteeProfileId;
    const isParticipant = isConsultant || isConsultee;

    if (!isPrivileged(session.user.role) && !isParticipant) {
      return forbiddenResponse(
        "You can only update consultations you are a participant in",
      );
    }

    const consultation = await prisma.consultation.update({
      where: { id },
      data: { requestStatus: status },
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
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
            payment: true,
          },
        },
      },
    });

    return NextResponse.json({ data: consultation });
  } catch (error) {
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}
