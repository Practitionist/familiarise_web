/**
 * Consultant Recordings API Route
 * GET /api/consultants/[consultantId]/recordings
 *
 * Gets all recordings for a consultant's webinars and classes.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { Prisma, RecordingStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

import { getSession } from "@/lib/auth-server";

export type ConsultantRecordingFilterType =
  "webinar" | "class" | "consultation" | "subscription" | "trial";

const VALID_RECORDING_TYPES = new Set<ConsultantRecordingFilterType>([
  "webinar",
  "class",
  "consultation",
  "subscription",
  "trial",
]);

const consultantRecordingFullInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                participants: {
                  where: liveParticipant(),
                  select: { user: { select: { name: true } } },
                },
                webinar: {
                  include: {
                    webinarPlan: { select: { id: true, title: true } },
                  },
                },
                class: {
                  include: {
                    classPlan: { select: { id: true, title: true } },
                  },
                },
                consultation: {
                  include: {
                    consultationPlan: { select: { id: true, title: true } },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: { select: { id: true, title: true } },
                  },
                },
                trial: {
                  include: {
                    subscriptionPlan: { select: { id: true, title: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

function buildConsultantTypeConditions(
  consultantProfileId: string,
  type: ConsultantRecordingFilterType | null,
): Prisma.RecordingWhereInput[] {
  const conditions: Prisma.RecordingWhereInput[] = [];

  if (!type || type === "webinar") {
    conditions.push(
      {
        meeting: {
          occurrence: {
            appointment: {
              webinar: { webinarPlan: { consultantProfileId } },
            },
          },
        },
      },
      {
        meeting: {
          occurrence: {
            appointment: {
              webinar: {
                webinarPlan: {
                  collaborators: {
                    some: { consultantProfileId, status: "ACCEPTED" },
                  },
                },
              },
            },
          },
        },
      },
    );
  }

  if (!type || type === "class") {
    conditions.push(
      {
        meeting: {
          occurrence: {
            appointment: {
              class: { classPlan: { consultantProfileId } },
            },
          },
        },
      },
      {
        meeting: {
          occurrence: {
            appointment: {
              class: {
                classPlan: {
                  collaborators: {
                    some: { consultantProfileId, status: "ACCEPTED" },
                  },
                },
              },
            },
          },
        },
      },
    );
  }

  if (!type || type === "consultation") {
    conditions.push({
      meeting: {
        occurrence: {
          appointment: {
            consultation: { consultationPlan: { consultantProfileId } },
          },
        },
      },
    });
  }

  if (!type || type === "subscription") {
    conditions.push({
      meeting: {
        occurrence: {
          appointment: {
            subscription: { subscriptionPlan: { consultantProfileId } },
          },
        },
      },
    });
  }

  if (!type || type === "trial") {
    conditions.push({
      meeting: {
        occurrence: {
          appointment: {
            trial: { subscriptionPlan: { consultantProfileId } },
          },
        },
      },
    });
  }

  return conditions;
}

type RouteParams = {
  params: Promise<{
    consultantId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantId } = await params;

    // Verify the user is accessing their own recordings
    if (session.user.role !== "ADMIN" && session.user.role !== "STAFF") {
      const consultantProfile = await prisma.consultantProfile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      });
      if (consultantProfile?.id !== consultantId) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const rawType = searchParams.get("type");
    const type: ConsultantRecordingFilterType | null =
      rawType &&
      VALID_RECORDING_TYPES.has(rawType as ConsultantRecordingFilterType)
        ? (rawType as ConsultantRecordingFilterType)
        : null;
    const status = searchParams.get("status") as RecordingStatus | null;
    const search = searchParams.get("search") || undefined;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "12");

    let recordings: Array<
      Prisma.Result<
        typeof prisma.recording,
        { include: typeof consultantRecordingFullInclude },
        "findFirstOrThrow"
      >
    >;
    let total: number;

    if (typeof prisma.recording?.findMany === "function") {
      const statusFilter = status
        ? { status }
        : { status: { notIn: ["FAILED", "EXPIRED"] as RecordingStatus[] } };
      const searchFilter = search
        ? { title: { contains: search, mode: "insensitive" as const } }
        : {};
      const where: Prisma.RecordingWhereInput = {
        OR: buildConsultantTypeConditions(consultantId, type),
        ...statusFilter,
        ...searchFilter,
        organizationId: null,
      };
      [recordings, total] = await Promise.all([
        prisma.recording.findMany({
          where,
          include: consultantRecordingFullInclude,
          orderBy: { recordedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.recording.count({ where }),
      ]);
    } else {
      const serviceResult = await RecordingService.getConsultantRecordings(
        consultantId,
        {
          type: (type as "webinar" | "class" | undefined) || undefined,
          status: status || undefined,
          search,
          page,
          limit,
          organizationId: null,
        },
      );
      recordings = serviceResult.recordings as typeof recordings;
      total = serviceResult.total;
    }

    // Map recordings to response format with best URLs (async — presigned URLs)
    const formattedRecordings = await Promise.all(
      recordings.map(async (recording) => {
        const slot = recording.meeting.occurrence;
        const appointment = slot.appointment as typeof slot.appointment & {
          consultation?: {
            consultationPlan?: { id: string; title: string } | null;
          } | null;
          subscription?: {
            subscriptionPlan?: { id: string; title: string } | null;
          } | null;
          trial?: {
            id?: string;
            trialPlan?: { id?: string; title?: string } | null;
            subscriptionPlan?: { id: string; title: string } | null;
          } | null;
        };

        let planType: ConsultantRecordingFilterType | null = null;
        let planId: string | null = null;
        let planTitle: string | null = null;

        if (appointment?.webinar?.webinarPlan) {
          planType = "webinar";
          planId = appointment.webinar.webinarPlan.id;
          planTitle = appointment.webinar.webinarPlan.title;
        } else if (appointment?.class?.classPlan) {
          planType = "class";
          planId = appointment.class.classPlan.id;
          planTitle = appointment.class.classPlan.title;
        } else if (appointment?.consultation?.consultationPlan) {
          planType = "consultation";
          planId = appointment.consultation.consultationPlan.id;
          planTitle = appointment.consultation.consultationPlan.title;
        } else if (appointment?.subscription?.subscriptionPlan) {
          planType = "subscription";
          planId = appointment.subscription.subscriptionPlan.id;
          planTitle = appointment.subscription.subscriptionPlan.title;
        } else if (appointment?.trial) {
          planType = "trial";
          planId =
            appointment.trial.trialPlan?.id ??
            appointment.trial.subscriptionPlan?.id ??
            null;
          planTitle =
            appointment.trial.trialPlan?.title ??
            appointment.trial.subscriptionPlan?.title ??
            "Free Trial";
        }

        const allNames = (appointment.participants ?? [])
          .map((participant) => participant.user.name)
          .filter((n): n is string => n !== null);
        const participantNames = allNames.slice(0, 3);
        const participantCount = allNames.length;

        return {
          id: recording.id,
          title: recording.title,
          durationInMinutes: recording.durationInMinutes,
          recordedAt: recording.recordedAt,
          status: recording.status,
          storageType: recording.storageType,
          playbackUrl: await getBestRecordingUrl(recording),
          thumbnailUrl: recording.thumbnailUrl,
          resolution: recording.resolution,
          fileSize: recording.fileSize ? Number(recording.fileSize) : null,
          streamUrlExpiresAt: recording.streamUrlExpiresAt,
          transferredAt: recording.transferredAt,
          planType,
          planId,
          planTitle,
          participantNames,
          participantCount,
          appointmentDate: slot.startsAt,
          createdAt: recording.createdAt,
          listingStatus: recording.listingStatus,
          listPricePaise:
            recording.listPricePaise !== null &&
            recording.listPricePaise !== undefined
              ? Number(recording.listPricePaise)
              : null,
          listingTitle: recording.listingTitle,
          listingDescription: recording.listingDescription,
          slug: recording.slug,
          tags: recording.tags,
          previewClipUrl: recording.previewClipUrl,
          previewTranscript: recording.previewTranscript,
          consentAttestedAt: recording.consentAttestedAt,
        };
      }),
    );

    return NextResponse.json({
      recordings: formattedRecordings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "consultants" } },
    );
    console.error("Error getting consultant recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
