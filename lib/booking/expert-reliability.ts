/**
 * Expert reliability strikes: one SystemEvent per expert-side cancel of a paid
 * booking or consultant no-show, on the `expert-reliability:` correlation (the
 * class-series flag keeps its own `class-reliability:` one). No money moves.
 */
import type { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  strikeWindowStart,
  type ExpertStrikeReviewRow,
} from "./expert-reliability-rules";

const PREFIX = "expert-reliability:";

const expertReliabilityCorrelationId = (consultantProfileId: string) =>
  `${PREFIX}${consultantProfileId}`;

type ExpertStrikeSource = "EXPERT_CANCEL" | "CONSULTANT_NO_SHOW";
/** A platform void is the platform's miss, never the expert's: it records nothing. */
type ExpertMissCause = ExpertStrikeSource | "PLATFORM_VOID";

/** Writes the strike on the caller's transaction, so it commits with the cancel or claim. */
export async function recordExpertStrike(
  tx: Pick<Tx, "systemEvent">,
  args: {
    consultantProfileId: string;
    cause: ExpertMissCause;
    appointmentId: string;
    organizationId?: string | null;
  },
): Promise<boolean> {
  if (args.cause === "PLATFORM_VOID") return false;
  await tx.systemEvent.create({
    data: {
      organizationId: args.organizationId ?? null,
      category: "BOOKING",
      severity: "WARN",
      message: `Expert reliability strike: ${args.cause}`,
      context: {
        strike: args.cause,
        consultantProfileId: args.consultantProfileId,
        appointmentId: args.appointmentId,
      },
      correlationId: expertReliabilityCorrelationId(args.consultantProfileId),
    },
  });
  return true;
}

type StrikeReader = { systemEvent: Pick<Tx["systemEvent"], "count"> };

export async function countExpertStrikes(
  consultantProfileId: string,
  since: Date,
  opts: { personalOnly?: boolean; db?: StrikeReader } = {},
): Promise<number> {
  const db = opts.db ?? prisma;
  return db.systemEvent.count({
    where: {
      correlationId: expertReliabilityCorrelationId(consultantProfileId),
      createdAt: { gte: since },
      ...(opts.personalOnly ? { organizationId: null } : {}),
    },
  });
}

/** The ops review list: experts with strikes in the window, most first. */
export async function readExpertStrikeReview(
  now = new Date(),
  limit = 50,
): Promise<ExpertStrikeReviewRow[]> {
  const where: Prisma.SystemEventWhereInput = {
    correlationId: { startsWith: PREFIX },
    createdAt: { gte: strikeWindowStart(now) },
  };
  const groups = await prisma.systemEvent.groupBy({
    by: ["correlationId"],
    where,
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _count: { correlationId: "desc" } },
    take: limit,
  });
  const ids = groups
    .map((g) => g.correlationId?.slice(PREFIX.length))
    .filter((id): id is string => !!id);
  const profiles = await prisma.consultantProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(profiles.map((p) => [p.id, p.user?.name ?? null]));
  return groups.flatMap((g) => {
    const id = g.correlationId?.slice(PREFIX.length);
    if (!id) return [];
    return [
      {
        consultantProfileId: id,
        name: nameOf.get(id) ?? null,
        strikes: g._count._all,
        lastStrikeAt: g._max.createdAt?.toISOString() ?? null,
      },
    ];
  });
}
