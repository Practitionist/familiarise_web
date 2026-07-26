/**
 * Shared list-recordings query for the #674 / B1-hybrid scope split.
 * `Recording.organizationId` is denormalized from the parent appointment
 * (kept in sync by checkout + the backfill script). Listing by org is
 * a single-hop lookup instead of joining through MeetingSession →
 * SlotOfAppointment → Appointment.
 */

import prisma from "@/lib/prisma";
import type { Prisma, RecordingStatus } from "@prisma/client";
import type { Scope } from "./parse";

export interface ListRecordingsParams {
  scope: Scope;
  userId: string;
  status?: RecordingStatus;
  page?: number;
  perPage?: number;
}

export interface ListRecordingsResult {
  items: Awaited<ReturnType<typeof prisma.recording.findMany>>;
  total: number;
  page: number;
  perPage: number;
}

function buildWhere(
  params: ListRecordingsParams,
): Prisma.RecordingWhereInput {
  const base: Prisma.RecordingWhereInput = {
    ...(params.status && { status: params.status }),
  };
  if (params.scope.kind === "personal") {
    return {
      ...base,
      organizationId: null,
      meetingSession: {
        slotOfAppointment: {
          appointment: {
            OR: [
              { consultation: { requestedBy: { userId: params.userId } } },
              { subscription: { requestedBy: { userId: params.userId } } },
              { trialSession: { consulteeProfile: { userId: params.userId } } },
            ],
          },
        },
      },
    };
  }
  if (params.scope.kind === "org") {
    return { ...base, organizationId: params.scope.orgId };
  }
  // `orgMember` = ONE member's own rows within an org. It must never fall
  // through to the unfiltered `base` below: that arm is the `all` scope
  // (admin/staff), and reaching it with an orgMember scope would return the
  // whole platform. `resolveOrgScope` now downgrades a non-operator's
  // ?orgScope=<orgId> to this kind, so the fall-through is live, not latent.
  if (params.scope.kind === "orgMember") {
    return {
      ...base,
      organizationId: params.scope.orgId,
      meetingSession: {
        slotOfAppointment: {
          appointment: {
            OR: [
              { consultation: { requestedBy: { userId: params.scope.userId } } },
              { subscription: { requestedBy: { userId: params.scope.userId } } },
              {
                trialSession: {
                  consulteeProfile: { userId: params.scope.userId },
                },
              },
              {
                consultation: {
                  consultationPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
              {
                subscription: {
                  subscriptionPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
              {
                webinar: {
                  webinarPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
              {
                class: {
                  classPlan: {
                    consultantProfile: { userId: params.scope.userId },
                  },
                },
              },
            ],
          },
        },
      },
    };
  }

  return base;
}

export async function listRecordingsScoped(
  params: ListRecordingsParams,
): Promise<ListRecordingsResult> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const where = buildWhere(params);

  const [total, items] = await prisma.$transaction([
    prisma.recording.count({ where }),
    prisma.recording.findMany({
      where,
      include: {
        meetingSession: {
          select: {
            id: true,
            slotOfAppointment: {
              select: {
                appointment: {
                  select: {
                    id: true,
                    appointmentType: true,
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { recordedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  return { items, total, page, perPage };
}
