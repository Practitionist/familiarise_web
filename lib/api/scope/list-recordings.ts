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
