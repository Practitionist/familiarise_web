/**
 * Consultee Recordings API Route
 * GET /api/consultees/[consulteeId]/recordings
 *
 * Gets all recordings the consultee has access to through their enrollments.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import prisma from "@/lib/prisma";

type RouteParams = {
  params: Promise<{
    consulteeId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consulteeId } = await params;

    // Verify the user is accessing their own recordings (or admin/staff)
    if (
      session.user.role !== "ADMIN" &&
      session.user.role !== "STAFF" &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403 }
      );
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type"); // "webinar" or "class"

    // Find all enrollments (paid appointments) for this consultee
    const enrolledAppointments = await prisma.payment.findMany({
      where: {
        userId: session.user.id,
        paymentStatus: "SUCCEEDED",
        appointment: {
          OR: [
            { webinar: { isNot: null } },
            { class: { isNot: null } },
          ],
        },
      },
      select: {
        appointment: {
          select: {
            id: true,
            webinarId: true,
            classId: true,
            webinar: {
              select: {
                id: true,
                webinarPlanId: true,
                webinarPlan: {
                  select: {
                    id: true,
                    title: true,
                    recordingEnabled: true,
                  },
                },
              },
            },
            class: {
              select: {
                id: true,
                classPlanId: true,
                classPlan: {
                  select: {
                    id: true,
                    title: true,
                    recordingEnabled: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Get unique plan IDs from paid enrollments using Set for O(n) performance
    // Note: recordingEnabled check removed for now - consultees can see all recordings they paid for
    // TODO: Re-add recordingEnabled filtering when implementing recording access tiers (see #366)
    const webinarPlanIds = Array.from(
      new Set(
        enrolledAppointments
          .map((e) => e.appointment?.webinar?.webinarPlanId)
          .filter((id): id is string => !!id)
      )
    );
    const classPlanIds = Array.from(
      new Set(
        enrolledAppointments
          .map((e) => e.appointment?.class?.classPlanId)
          .filter((id): id is string => !!id)
      )
    );

    // Build query based on type filter
    const whereConditions = [];

    if (!type || type === "webinar") {
      if (webinarPlanIds.length > 0) {
        whereConditions.push({
          meetingSession: {
            slotOfAppointment: {
              appointment: {
                webinar: {
                  webinarPlanId: {
                    in: webinarPlanIds,
                  },
                },
              },
            },
          },
        });
      }
    }

    if (!type || type === "class") {
      if (classPlanIds.length > 0) {
        whereConditions.push({
          meetingSession: {
            slotOfAppointment: {
              appointment: {
                class: {
                  classPlanId: {
                    in: classPlanIds,
                  },
                },
              },
            },
          },
        });
      }
    }

    // If no valid enrollments found, return empty array
    if (whereConditions.length === 0) {
      return NextResponse.json({
        recordings: [],
        total: 0,
      });
    }

    // Fetch recordings for enrolled plans
    const recordings = await prisma.recording.findMany({
      where: {
        OR: whereConditions,
        status: {
          notIn: ["FAILED", "EXPIRED"],
        },
      },
      include: {
        meetingSession: {
          include: {
            slotOfAppointment: {
              include: {
                appointment: {
                  include: {
                    webinar: {
                      include: {
                        webinarPlan: {
                          select: {
                            id: true,
                            title: true,
                          },
                        },
                      },
                    },
                    class: {
                      include: {
                        classPlan: {
                          select: {
                            id: true,
                            title: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        recordedAt: "desc",
      },
    });

    // Format recordings for response
    const formattedRecordings = recordings.map((recording) => {
      const appointment =
        recording.meetingSession?.slotOfAppointment?.appointment;

      let planType: "webinar" | "class" | null = null;
      let planId: string | null = null;
      let planTitle: string | null = null;

      if (appointment?.webinar?.webinarPlan) {
        planType = "webinar";
        planId = appointment.webinar.webinarPlan.id ?? null;
        planTitle = appointment.webinar.webinarPlan.title ?? null;
      } else if (appointment?.class?.classPlan) {
        planType = "class";
        planId = appointment.class.classPlan.id ?? null;
        planTitle = appointment.class.classPlan.title ?? null;
      }

      return {
        id: recording.id,
        title: recording.title,
        durationInMinutes: recording.durationInMinutes,
        recordedAt: recording.recordedAt,
        status: recording.status,
        storageType: recording.storageType,
        playbackUrl: RecordingTransferService.getBestRecordingUrl(recording),
        thumbnailUrl: recording.thumbnailUrl,
        resolution: recording.resolution,
        planType,
        planId,
        planTitle,
        createdAt: recording.createdAt,
      };
    });

    return NextResponse.json({
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    console.error("Error getting consultee recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 }
    );
  }
}
