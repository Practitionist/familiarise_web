import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

const planMaterialSelect = {
  id: true,
  fileName: true,
  originalName: true,
  fileSize: true,
  mimeType: true,
  fileUrl: true,
  description: true,
  order: true,
  uploadedAt: true,
} satisfies Prisma.PlanMaterialSelect;

const consultantUserSelect = {
  id: true,
  name: true,
  image: true,
} satisfies Prisma.UserSelect;

const slotsWithRecordings = {
  slotsOfAppointment: {
    include: {
      meetingSession: {
        include: {
          recordings: {
            where: {
              status: { notIn: ["FAILED", "EXPIRED"] },
            },
            orderBy: { recordedAt: "desc" as const },
          },
        },
      },
    },
  },
} satisfies Prisma.AppointmentInclude;

const consultationInclude = {
  consultationPlan: {
    include: {
      materials: {
        select: planMaterialSelect,
        orderBy: { order: "asc" as const },
      },
      consultantProfile: {
        include: { user: { select: consultantUserSelect } },
      },
    },
  },
  appointment: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.ConsultationInclude;

const subscriptionInclude = {
  subscriptionPlan: {
    include: {
      materials: {
        select: planMaterialSelect,
        orderBy: { order: "asc" as const },
      },
      consultantProfile: {
        include: { user: { select: consultantUserSelect } },
      },
    },
  },
  appointments: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.SubscriptionInclude;

const webinarInclude = {
  webinarPlan: {
    include: {
      materials: {
        select: planMaterialSelect,
        orderBy: { order: "asc" as const },
      },
      consultantProfile: {
        include: { user: { select: consultantUserSelect } },
      },
    },
  },
  appointment: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.WebinarInclude;

const classInclude = {
  classPlan: {
    include: {
      materials: {
        select: planMaterialSelect,
        orderBy: { order: "asc" as const },
      },
      consultantProfile: {
        include: { user: { select: consultantUserSelect } },
      },
    },
  },
  appointments: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.ClassInclude;

type ConsultationWithResources = Prisma.ConsultationGetPayload<{
  include: typeof consultationInclude;
}>;
type SubscriptionWithResources = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;
type WebinarWithResources = Prisma.WebinarGetPayload<{
  include: typeof webinarInclude;
}>;
type ClassWithResources = Prisma.ClassGetPayload<{
  include: typeof classInclude;
}>;

// Appointment type that has slotsOfAppointment with meetingSession recordings
type AppointmentWithSlots = Prisma.AppointmentGetPayload<{
  include: typeof slotsWithRecordings;
}>;

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
      return forbiddenResponse("You can only access your own resources");
    }

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

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

    // Get paid plan IDs via shared RecordingService method
    const {
      webinarPlanIds: paidWebinarPlanIds,
      classPlanIds: paidClassPlanIds,
    } = await RecordingService.getPaidPlanIds(userId);

    const [consultations, subscriptions, webinars, classes] = await Promise.all(
      [
        prisma.consultation.findMany({
          where: { requestedById: consulteeId },
          include: consultationInclude,
          orderBy: { requestedAt: "desc" },
        }),

        prisma.subscription.findMany({
          where: { requestedById: consulteeId },
          include: subscriptionInclude,
          orderBy: { requestedAt: "desc" },
        }),

        prisma.webinar.findMany({
          where: {
            OR: [
              // Instances the user directly attended
              {
                appointment: {
                  slotsOfAppointment: {
                    some: { user: { some: { id: userId } } },
                  },
                },
              },
              // Other instances from paid plans that have recordings
              ...(paidWebinarPlanIds.length > 0
                ? [
                    {
                      webinarPlanId: { in: paidWebinarPlanIds },
                      appointment: {
                        slotsOfAppointment: {
                          some: {
                            meetingSession: {
                              recordings: {
                                some: {
                                  status: {
                                    notIn: [
                                      "FAILED" as const,
                                      "EXPIRED" as const,
                                    ],
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  ]
                : []),
            ],
          },
          include: webinarInclude,
          orderBy: { createdAt: "desc" },
        }),

        prisma.class.findMany({
          where: {
            OR: [
              // Instances the user directly attended
              {
                appointments: {
                  some: {
                    slotsOfAppointment: {
                      some: { user: { some: { id: userId } } },
                    },
                  },
                },
              },
              // Other instances from paid plans that have recordings
              ...(paidClassPlanIds.length > 0
                ? [
                    {
                      classPlanId: { in: paidClassPlanIds },
                      appointments: {
                        some: {
                          slotsOfAppointment: {
                            some: {
                              meetingSession: {
                                recordings: {
                                  some: {
                                    status: {
                                      notIn: [
                                        "FAILED" as const,
                                        "EXPIRED" as const,
                                      ],
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  ]
                : []),
            ],
          },
          include: classInclude,
          orderBy: { createdAt: "desc" },
        }),
      ],
    );

    // Include if COMPLETED or has at least 1 material/recording
    type TransformedEvent = {
      status: string;
      materials: unknown[];
      recordings: unknown[];
    };
    const shouldInclude = (e: TransformedEvent) =>
      e.status === "COMPLETED" ||
      e.materials.length > 0 ||
      e.recordings.length > 0;

    const transform = {
      consultations: (
        await Promise.all(
          consultations.map(async (c: ConsultationWithResources) => ({
            id: c.id,
            planTitle: c.consultationPlan.title,
            consultantName: c.consultationPlan.consultantProfile.user.name,
            consultantImage: c.consultationPlan.consultantProfile.user.image,
            status: c.requestStatus,
            date:
              c.appointment?.slotsOfAppointment?.[0]?.startsAt ||
              c.requestedAt,
            materials: c.consultationPlan.materials,
            recordings: await extractRecordings(
              c.appointment ? [c.appointment] : [],
            ),
          })),
        )
      ).filter(shouldInclude),
      subscriptions: (
        await Promise.all(
          subscriptions.map(async (s: SubscriptionWithResources) => ({
            id: s.id,
            planTitle: s.subscriptionPlan.title,
            consultantName: s.subscriptionPlan.consultantProfile.user.name,
            consultantImage: s.subscriptionPlan.consultantProfile.user.image,
            status: s.requestStatus,
            date: s.schedulingPeriodStartsAt || s.requestedAt,
            materials: s.subscriptionPlan.materials,
            recordings: await extractRecordings(s.appointments),
          })),
        )
      ).filter((e) => e.status !== "PENDING" && shouldInclude(e)),
      webinars: (
        await Promise.all(
          webinars.map(async (w: WebinarWithResources) => ({
            id: w.id,
            planTitle: w.webinarPlan.title,
            consultantName: w.webinarPlan.consultantProfile?.user.name ?? null,
            consultantImage:
              w.webinarPlan.consultantProfile?.user.image ?? null,
            status: w.status,
            date:
              w.appointment?.slotsOfAppointment?.[0]?.startsAt || w.createdAt,
            materials: w.webinarPlan.materials,
            recordings: await extractRecordings(
              w.appointment ? [w.appointment] : [],
            ),
          })),
        )
      ).filter(shouldInclude),
      classes: (
        await Promise.all(
          classes.map(async (cl: ClassWithResources) => ({
            id: cl.id,
            planTitle: cl.classPlan.title,
            consultantName: cl.classPlan.consultantProfile?.user.name ?? null,
            consultantImage:
              cl.classPlan.consultantProfile?.user.image ?? null,
            status: cl.status,
            date:
              cl.schedulingPeriodStartsAt ||
              cl.appointments?.[0]?.slotsOfAppointment?.[0]?.startsAt ||
              cl.createdAt,
            materials: cl.classPlan.materials,
            recordings: await extractRecordings(cl.appointments),
          })),
        )
      ).filter(shouldInclude),
    };

    return NextResponse.json({ data: transform, success: true });
  } catch (error) {
    console.error("Error fetching consultee resources:", error);
    return NextResponse.json(
      { error: "Failed to fetch resources" },
      { status: 500 },
    );
  }
}

async function extractRecordings(appointments: AppointmentWithSlots[]) {
  const recordings = appointments.flatMap((apt) =>
    apt.slotsOfAppointment.flatMap(
      (slot) => slot.meetingSession?.recordings ?? [],
    ),
  );

  return Promise.all(
    recordings.map(async (rec) => ({
      id: rec.id,
      title: rec.title,
      durationInMinutes: rec.durationInMinutes,
      recordedAt: rec.recordedAt,
      playbackUrl: await RecordingTransferService.getBestRecordingUrl(rec),
      thumbnailUrl: rec.thumbnailUrl,
      status: rec.status,
    })),
  );
}
