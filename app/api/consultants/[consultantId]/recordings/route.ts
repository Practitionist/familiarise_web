/**
 * Consultant Recordings API Route
 * GET /api/consultants/[consultantId]/recordings
 *
 * Gets all recordings for a consultant's webinars and classes.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma, RecordingStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { getSession } from "@/lib/auth-server";
import {
  isDiscoverablePlanPlan,
  resolveListingPlan,
} from "@/lib/stream/recording-listing-access";
import {
  auditOperatorRecordingAccess,
  resolveOperatorRecordingAccess,
} from "@/lib/stream/recording-operator-access";
import { isDurablyOurs } from "@/lib/stream/recording-storage";

export type ConsultantRecordingFilterType =
  "webinar" | "class" | "consultation" | "subscription" | "trial";

const QuerySchema = z.object({
  type: z
    .enum(["webinar", "class", "consultation", "subscription", "trial"])
    .optional(),
  status: z.nativeEnum(RecordingStatus).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const consultantRecordingFullInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    purchases: {
      where: { status: "SUCCEEDED" },
      select: { id: true },
      take: 1,
    },
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
                    webinarPlan: {
                      select: {
                        id: true,
                        title: true,
                        consultantProfileId: true,
                        organizationId: true,
                        visibility: true,
                        archivedAt: true,
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
                        consultantProfileId: true,
                        organizationId: true,
                        visibility: true,
                        archivedAt: true,
                      },
                    },
                  },
                },
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        id: true,
                        title: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        id: true,
                        title: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                trial: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        id: true,
                        title: true,
                        consultantProfileId: true,
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
  });

type ConsultantRecordingRow = Prisma.Result<
  typeof prisma.recording,
  { include: typeof consultantRecordingFullInclude },
  "findFirstOrThrow"
>;

type RecordingAppointment =
  ConsultantRecordingRow["meeting"]["occurrence"]["appointment"];

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

function resolveRecordingPlanInfo(appointment: RecordingAppointment): {
  planType: ConsultantRecordingFilterType | null;
  planId: string | null;
  planTitle: string | null;
  ownerProfileId: string | null;
} {
  if (appointment?.webinar?.webinarPlan) {
    const plan = appointment.webinar.webinarPlan;
    return {
      planType: "webinar",
      planId: plan.id,
      planTitle: plan.title,
      ownerProfileId: plan.consultantProfileId,
    };
  }
  if (appointment?.class?.classPlan) {
    const plan = appointment.class.classPlan;
    return {
      planType: "class",
      planId: plan.id,
      planTitle: plan.title,
      ownerProfileId: plan.consultantProfileId,
    };
  }
  if (appointment?.consultation?.consultationPlan) {
    const plan = appointment.consultation.consultationPlan;
    return {
      planType: "consultation",
      planId: plan.id,
      planTitle: plan.title,
      ownerProfileId: plan.consultantProfileId,
    };
  }
  if (appointment?.subscription?.subscriptionPlan) {
    const plan = appointment.subscription.subscriptionPlan;
    return {
      planType: "subscription",
      planId: plan.id,
      planTitle: plan.title,
      ownerProfileId: plan.consultantProfileId,
    };
  }
  if (appointment?.trial) {
    const plan = appointment.trial.subscriptionPlan;
    return {
      planType: "trial",
      planId: plan?.id ?? null,
      planTitle: plan?.title ?? "Free Trial",
      ownerProfileId: plan?.consultantProfileId ?? null,
    };
  }
  return {
    planType: null,
    planId: null,
    planTitle: null,
    ownerProfileId: null,
  };
}

function formatConsultantRecording(
  recording: ConsultantRecordingRow,
  consultantId: string,
  includeMediaUrls: boolean,
) {
  const slot = recording.meeting.occurrence;
  const appointment = slot.appointment;
  const { planType, planId, planTitle, ownerProfileId } =
    resolveRecordingPlanInfo(appointment);

  const isPrimaryOwner = ownerProfileId === consultantId;
  const listingPlan = resolveListingPlan(appointment);
  const canManage = isPrimaryOwner;
  const canPublish =
    isPrimaryOwner &&
    listingPlan !== null &&
    isDiscoverablePlanPlan(listingPlan.plan) &&
    isDurablyOurs(recording);
  const hasBuyers = recording.purchases.length > 0;

  const allNames = (appointment.participants ?? [])
    .map((participant) => participant.user.name)
    .filter((n): n is string => n !== null);

  return {
    id: recording.id,
    title: recording.title,
    durationInMinutes: recording.durationInMinutes,
    recordedAt: recording.recordedAt,
    status: recording.status,
    storageType: recording.storageType,
    playbackUrl: null,
    thumbnailUrl: includeMediaUrls ? recording.thumbnailUrl : null,
    resolution: recording.resolution,
    fileSize: recording.fileSize ? Number(recording.fileSize) : null,
    streamUrlExpiresAt: recording.streamUrlExpiresAt,
    transferredAt: recording.transferredAt,
    planType,
    planId,
    planTitle,
    participantNames: allNames.slice(0, 3),
    participantCount: allNames.length,
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
    previewClipUrl: includeMediaUrls ? recording.previewClipUrl : null,
    previewTranscript: recording.previewTranscript,
    consentAttestedAt: recording.consentAttestedAt,
    hasBuyers,
    canManage,
    canPublish,
  };
}

async function authorizeConsultantRecordings(
  user: {
    id: string;
    role?: string | null;
    consultantProfileId?: string | null;
  },
  consultantId: string,
): Promise<{ allowed: boolean; includeMediaUrls: boolean }> {
  if (user.consultantProfileId === consultantId) {
    return { allowed: true, includeMediaUrls: true };
  }

  const consultantProfile = await prisma.consultantProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (consultantProfile?.id === consultantId) {
    return { allowed: true, includeMediaUrls: true };
  }

  const operator = resolveOperatorRecordingAccess(user.role);
  if (!operator.canRead) {
    return { allowed: false, includeMediaUrls: false };
  }

  await auditOperatorRecordingAccess({
    actorUserId: user.id,
    actorRole: user.role ?? "UNKNOWN",
    surface: "GET /api/consultants/[consultantId]/recordings",
    played: operator.canPlay,
  });

  return { allowed: true, includeMediaUrls: operator.canPlay };
}

type RouteParams = {
  params: Promise<{
    consultantId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession(true);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantId } = await params;
    const access = await authorizeConsultantRecordings(
      session.user,
      consultantId,
    );
    if (!access.allowed) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const parsedQuery = QuerySchema.safeParse({
      type: searchParams.get("type") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      search: searchParams.get("search") || undefined,
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query parameters" },
        { status: 400 },
      );
    }

    const { type = null, status, search, page, limit } = parsedQuery.data;
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

    const recordings = await prisma.recording.findMany({
      where,
      include: consultantRecordingFullInclude,
      orderBy: { recordedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await prisma.recording.count({ where });

    const formattedRecordings = recordings.map((recording) =>
      formatConsultantRecording(
        recording,
        consultantId,
        access.includeMediaUrls,
      ),
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
