import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { liveParticipant } from "@/lib/booking/participants";

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
  occurrences: {
    include: {
      meeting: {
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
  appointment: {
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
  appointment: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.ClassInclude;

// Trials ride the subscription plan's materials + the single trial
// appointment's recordings — same shape as consultations.
const trialInclude = {
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
  appointment: {
    include: slotsWithRecordings,
  },
} satisfies Prisma.TrialInclude;

// Derived via the extended client — raw GetPayload would re-introduce
// bigint money/fileSize fields (#780).
type ConsultationWithResources = Prisma.Result<
  typeof prisma.consultation,
  { include: typeof consultationInclude },
  "findFirstOrThrow"
>;
type SubscriptionWithResources = Prisma.Result<
  typeof prisma.subscription,
  { include: typeof subscriptionInclude },
  "findFirstOrThrow"
>;
type WebinarWithResources = Prisma.Result<
  typeof prisma.webinar,
  { include: typeof webinarInclude },
  "findFirstOrThrow"
>;
type ClassWithResources = Prisma.Result<
  typeof prisma.class,
  { include: typeof classInclude },
  "findFirstOrThrow"
>;
type TrialWithResources = Prisma.Result<
  typeof prisma.trial,
  { include: typeof trialInclude },
  "findFirstOrThrow"
>;

// Appointment type that has occurrences with meeting recordings
type AppointmentWithSlots = Prisma.Result<
  typeof prisma.appointment,
  { include: typeof slotsWithRecordings },
  "findFirstOrThrow"
>;

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

    // #1166 ORG-4 — personal surface: participation arms pin the appointment
    // to organizationId: null (ADR 19; mirrors the events read). The
    // paid-plan arms below stay unpinned — they are payment-derived CONTENT
    // entitlement, not booking scope, and pinning them would revoke
    // recordings the user paid for. Trials stay unpinned (attribution-only
    // org tag, always B2C).
    const [consultations, subscriptions, webinars, classes, trials] =
      await Promise.all([
        prisma.consultation.findMany({
          where: {
            requestedById: consulteeId,
            appointment: { is: { organizationId: null } },
          },
          include: consultationInclude,
          orderBy: { requestedAt: "desc" },
        }),

        prisma.subscription.findMany({
          where: {
            requestedById: consulteeId,
            appointment: { organizationId: null },
          },
          include: subscriptionInclude,
          orderBy: { requestedAt: "desc" },
        }),

        prisma.webinar.findMany({
          where: {
            OR: [
              // Instances the user directly attended
              {
                appointment: {
                  organizationId: null,
                  participants: { some: liveParticipant(userId) },
                },
              },
              // Other instances from paid plans that have recordings
              ...(paidWebinarPlanIds.length > 0
                ? [
                    {
                      webinarPlanId: { in: paidWebinarPlanIds },
                      appointment: {
                        occurrences: {
                          some: {
                            meeting: {
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
                appointment: {
                  organizationId: null,
                  participants: { some: liveParticipant(userId) },
                },
              },
              // Other instances from paid plans that have recordings
              ...(paidClassPlanIds.length > 0
                ? [
                    {
                      classPlanId: { in: paidClassPlanIds },
                      appointment: {
                        occurrences: {
                          some: {
                            meeting: {
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
          include: classInclude,
          orderBy: { createdAt: "desc" },
        }),

        prisma.trial.findMany({
          where: { consulteeProfileId: consulteeId },
          include: trialInclude,
          orderBy: { requestedAt: "desc" },
        }),
      ]);

    // Include if COMPLETED or has at least 1 material/recording. Seeds carry
    // the appointment (not recordings) so the filter + mint share one shape.
    const shouldIncludeSeed = (e: ResourceRowSeed) =>
      e.status === "COMPLETED" ||
      e.materials.length > 0 ||
      collectRecordings(e.appointment ? [e.appointment] : []).length > 0;

    const transform = {
      // URLs are minted AFTER the filter: the old code minted a signed URL
      // per recording per row and then threw rows away in shouldInclude.
      // The five types share one seed shape + one filter/mint pass so the
      // per-type code is only the field mapping (Sonar duplication gate).
      consultations: await withUrls(
        consultations
          .map((c: ConsultationWithResources): ResourceRowSeed => ({
            id: c.id,
            planTitle: c.consultationPlan.title,
            consultantName: c.consultationPlan.consultantProfile.user.name,
            consultantImage: c.consultationPlan.consultantProfile.user.image,
            status: c.status,
            date: c.appointment?.occurrences?.[0]?.startsAt || c.requestedAt,
            materials: c.consultationPlan.materials,
            appointment: c.appointment,
          }))
          .filter(shouldIncludeSeed),
      ),
      subscriptions: await withUrls(
        subscriptions
          .map((s: SubscriptionWithResources): ResourceRowSeed => ({
            id: s.id,
            planTitle: s.subscriptionPlan.title,
            consultantName: s.subscriptionPlan.consultantProfile.user.name,
            consultantImage: s.subscriptionPlan.consultantProfile.user.image,
            status: s.status,
            date: s.schedulingPeriodStartsAt || s.requestedAt,
            materials: s.subscriptionPlan.materials,
            appointment: s.appointment,
          }))
          .filter((e) => e.status !== "PENDING" && shouldIncludeSeed(e)),
      ),
      webinars: await withUrls(
        webinars
          .map((w: WebinarWithResources): ResourceRowSeed => ({
            id: w.id,
            planTitle: w.webinarPlan.title,
            consultantName: w.webinarPlan.consultantProfile?.user.name ?? null,
            consultantImage:
              w.webinarPlan.consultantProfile?.user.image ?? null,
            status: w.status,
            date: w.appointment?.occurrences?.[0]?.startsAt || w.createdAt,
            materials: w.webinarPlan.materials,
            appointment: w.appointment,
          }))
          .filter(shouldIncludeSeed),
      ),
      classes: await withUrls(
        classes
          .map((cl: ClassWithResources): ResourceRowSeed => ({
            id: cl.id,
            planTitle: cl.classPlan.title,
            consultantName: cl.classPlan.consultantProfile?.user.name ?? null,
            consultantImage: cl.classPlan.consultantProfile?.user.image ?? null,
            status: cl.status,
            date:
              cl.schedulingPeriodStartsAt ||
              cl.appointment?.occurrences?.[0]?.startsAt ||
              cl.createdAt,
            materials: cl.classPlan.materials,
            appointment: cl.appointment,
          }))
          .filter(shouldIncludeSeed),
      ),
      trials: await withUrls(
        trials
          .map((t: TrialWithResources): ResourceRowSeed => ({
            id: t.id,
            planTitle: `Trial: ${t.subscriptionPlan.title}`,
            consultantName:
              t.subscriptionPlan.consultantProfile?.user.name ?? null,
            consultantImage:
              t.subscriptionPlan.consultantProfile?.user.image ?? null,
            status: t.status,
            date: t.appointment?.occurrences?.[0]?.startsAt || t.requestedAt,
            materials: t.subscriptionPlan.materials,
            appointment: t.appointment,
          }))
          .filter(shouldIncludeSeed),
      ),
    };

    return NextResponse.json({ data: transform, success: true });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching consultee resources:", error);
    return NextResponse.json(
      { error: "Failed to fetch resources" },
      { status: 500 },
    );
  }
}

type RawRecording = NonNullable<
  AppointmentWithSlots["occurrences"][number]["meeting"]
>["recordings"][number];

/** Flatten slots → recordings without minting URLs (sync, free). */
function collectRecordings(appointments: AppointmentWithSlots[]) {
  return appointments.flatMap((apt) =>
    apt.occurrences.flatMap((slot) => slot.meeting?.recordings ?? []),
  );
}

/** The recording shape the client receives (never the full DB row). */
type RecordingView = Pick<
  RawRecording,
  | "id"
  | "title"
  | "durationInMinutes"
  | "recordedAt"
  | "thumbnailUrl"
  | "status"
> & { playbackUrl: string | null };

/**
 * Mint playback URLs with bounded concurrency: every AVAILABLE recording
 * costs one Supabase signed-URL mint, and the old code fanned them out
 * unbounded (one per recording on the page). 6 at a time keeps tail latency
 * flat without serialising the page.
 */
async function mintRecordingUrls(
  recordings: RawRecording[],
): Promise<RecordingView[]> {
  const out: RecordingView[] = new Array(recordings.length);
  let next = 0;
  const workers = new Array(Math.min(6, recordings.length))
    .fill(null)
    .map(async () => {
      while (next < recordings.length) {
        const i = next++;
        const rec = recordings[i];
        out[i] = {
          id: rec.id,
          title: rec.title,
          durationInMinutes: rec.durationInMinutes,
          recordedAt: rec.recordedAt,
          playbackUrl: await getBestRecordingUrl(rec),
          thumbnailUrl: rec.thumbnailUrl,
          status: rec.status,
        };
      }
    });
  await Promise.all(workers);
  return out;
}

/** One seed shape for all five booking types (Sonar duplication gate). */
interface ResourceRowSeed {
  id: string;
  planTitle: string;
  consultantName: string | null;
  consultantImage: string | null;
  status: string;
  date: Date;
  materials: unknown[];
  appointment: AppointmentWithSlots | null;
}

/** Mint URLs only for rows that survived the filter (see shouldIncludeSeed). */
async function withUrls(
  rows: ResourceRowSeed[],
): Promise<Array<Omit<ResourceRowSeed, "appointment"> & { recordings: RecordingView[] }>> {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const { appointment, ...rest } = rows[i];
    out[i] = {
      ...rest,
      recordings: await mintRecordingUrls(
        collectRecordings(appointment ? [appointment] : []),
      ),
    };
  }
  return out;
}
