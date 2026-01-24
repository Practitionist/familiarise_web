/**
 * Waitlist Entry API Routes
 * GET: Get waitlist entry details
 * DELETE: Leave waitlist
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { calculatePosition, leaveWaitlist } from "@/lib/waitlist";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/waitlist/[id] - Get waitlist entry details
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await params;

    const entry = await prisma.waitlist.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        name: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            appointment: {
              include: {
                slotsOfAppointment: {
                  take: 1,
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
                    user: {
                      select: {
                        name: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            appointments: {
              take: 1,
              include: {
                slotsOfAppointment: {
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, error: "Waitlist entry not found" },
        { status: 404 }
      );
    }

    // Verify user owns this entry or is admin
    if (entry.userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 }
      );
    }

    // Calculate current position if status is WAITING
    let position = entry.position;
    if (entry.status === "WAITING") {
      position = await calculatePosition(entry.id);
    }

    return NextResponse.json({
      success: true,
      data: {
        ...entry,
        position,
      },
    });
  } catch (error) {
    console.error("Error fetching waitlist entry:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch waitlist entry" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/waitlist/[id] - Leave waitlist
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { id } = await params;

    const result = await leaveWaitlist({
      waitlistId: id,
      userId: session.user.id,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error("Error leaving waitlist:", error);
    return NextResponse.json(
      { success: false, error: "Failed to leave waitlist" },
      { status: 500 }
    );
  }
}
