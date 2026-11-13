/**
 * Expert reliability strikes: one SystemEvent per expert-side cancel of a paid
 * booking or consultant no-show, on the `expert-reliability:` correlation (the
 * class-series flag keeps its own `class-reliability:` one). No money moves.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import {
  EXPERT_STRIKE_WINDOW_DAYS,
  strikeWindowStart,
  type ExpertStrikeReviewRow,
  type OwnStrikes,
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
    /** The sessions the strike is for; an incident over another session of the booking does not void it. */
    occurrenceIds: string[];
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
        occurrenceIds: args.occurrenceIds,
      },
      correlationId: expertReliabilityCorrelationId(args.consultantProfileId),
    },
  });
  return true;
}

type StrikeReader = Pick<
  Tx,
  "systemEvent" | "platformIncident" | "appointmentOccurrence"
>;

/** Strike rows read per call; an expert past this many is flagged regardless. */
const STRIKE_READ_CAP = 2_000;
const INCIDENT_LOOKBACK_MS = 7 * 86_400_000;
const strikeContextSchema = z.object({
  appointmentId: z.string(),
  occurrenceIds: z.array(z.string()).optional(),
});
type StrikeContext = z.infer<typeof strikeContextSchema>;

const strikeContextOf = (context: Prisma.JsonValue): StrikeContext | null => {
  const parsed = strikeContextSchema.safeParse(context);
  return parsed.success ? parsed.data : null;
};

/**
 * The sessions inside a declared incident, among those the strikes name; a
 * strike recorded without its sessions is judged by its whole booking.
 */
async function incidentCovered(
  db: StrikeReader,
  contexts: StrikeContext[],
  since: Date,
): Promise<(context: StrikeContext) => boolean> {
  const occurrenceIds = [
    ...new Set(contexts.flatMap((c) => c.occurrenceIds ?? [])),
  ];
  const bookingIds = [
    ...new Set(
      contexts
        .filter((c) => !c.occurrenceIds?.length)
        .map((c) => c.appointmentId),
    ),
  ];
  if (occurrenceIds.length === 0 && bookingIds.length === 0) return () => false;
  const incidents = await db.platformIncident.findMany({
    where: { endsAt: { gt: new Date(since.getTime() - INCIDENT_LOOKBACK_MS) } },
    select: { startsAt: true, endsAt: true },
    take: 200,
  });
  if (incidents.length === 0) return () => false;
  const rows = await db.appointmentOccurrence.findMany({
    where: {
      AND: [
        {
          OR: [
            ...(occurrenceIds.length > 0
              ? [{ id: { in: occurrenceIds } }]
              : []),
            ...(bookingIds.length > 0
              ? [{ appointmentId: { in: bookingIds } }]
              : []),
          ],
        },
        {
          OR: incidents.map((w) => ({
            startsAt: { lt: w.endsAt },
            endsAt: { gt: w.startsAt },
          })),
        },
      ],
    },
    select: { id: true, appointmentId: true },
  });
  const sessions = new Set(rows.map((r) => r.id));
  const bookings = new Set(rows.map((r) => r.appointmentId));
  return (context) =>
    context.occurrenceIds?.length
      ? context.occurrenceIds.some((id) => sessions.has(id))
      : bookings.has(context.appointmentId);
}

/** The strikes in the window, less those on a session a declared incident voided. */
async function countableStrikes<R extends { context: Prisma.JsonValue }>(
  db: StrikeReader,
  rows: R[],
  since: Date,
): Promise<R[]> {
  const contexts = rows.flatMap((r) => strikeContextOf(r.context) ?? []);
  const covered = await incidentCovered(db, contexts, since);
  return rows.filter((r) => {
    const context = strikeContextOf(r.context);
    return !context || !covered(context);
  });
}

export async function countExpertStrikes(
  consultantProfileId: string,
  since: Date,
  opts: { personalOnly?: boolean; db?: StrikeReader } = {},
): Promise<number> {
  const db = opts.db ?? prisma;
  const rows = await db.systemEvent.findMany({
    where: {
      correlationId: expertReliabilityCorrelationId(consultantProfileId),
      createdAt: { gte: since },
      ...(opts.personalOnly ? { organizationId: null } : {}),
    },
    select: { context: true },
    take: STRIKE_READ_CAP,
  });
  if (rows.length === 0) return 0;
  return (await countableStrikes(db, rows, since)).length;
}

const ownStrikeCauseSchema = z.object({
  strike: z.enum(["EXPERT_CANCEL", "CONSULTANT_NO_SHOW"]),
});
const OWN_RECENT_LIMIT = 10;

/** The expert's own strikes in the window, newest first, less those a declared incident voided. */
export async function readOwnStrikes(
  consultantProfileId: string,
  opts: { now?: Date; db?: StrikeReader } = {},
): Promise<OwnStrikes> {
  const db = opts.db ?? prisma;
  const since = strikeWindowStart(opts.now ?? new Date());
  const rows = await db.systemEvent.findMany({
    where: {
      correlationId: expertReliabilityCorrelationId(consultantProfileId),
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, context: true },
    take: STRIKE_READ_CAP,
  });
  const counted = await countableStrikes(db, rows, since);
  return {
    windowDays: EXPERT_STRIKE_WINDOW_DAYS,
    count: counted.length,
    recent: counted.slice(0, OWN_RECENT_LIMIT).flatMap((row) => {
      const parsed = ownStrikeCauseSchema.safeParse(row.context);
      return parsed.success
        ? [{ at: row.createdAt.toISOString(), cause: parsed.data.strike }]
        : [];
    }),
  };
}

/** The ops review list: experts with strikes in the window, most first. */
export async function readExpertStrikeReview(
  now = new Date(),
  limit = 50,
): Promise<ExpertStrikeReviewRow[]> {
  const since = strikeWindowStart(now);
  const rows = await prisma.systemEvent.findMany({
    where: {
      correlationId: { startsWith: PREFIX },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { correlationId: true, createdAt: true, context: true },
    take: STRIKE_READ_CAP,
  });
  const byExpert = new Map<string, { strikes: number; lastStrikeAt: Date }>();
  for (const row of await countableStrikes(prisma, rows, since)) {
    const id = row.correlationId?.slice(PREFIX.length);
    if (!id) continue;
    const seen = byExpert.get(id);
    if (seen) seen.strikes += 1;
    else byExpert.set(id, { strikes: 1, lastStrikeAt: row.createdAt });
  }
  const top = [...byExpert.entries()]
    .sort((a, b) => b[1].strikes - a[1].strikes)
    .slice(0, limit);
  const profiles = await prisma.consultantProfile.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(profiles.map((p) => [p.id, p.user?.name ?? null]));
  return top.map(([id, g]) => ({
    consultantProfileId: id,
    name: nameOf.get(id) ?? null,
    strikes: g.strikes,
    lastStrikeAt: g.lastStrikeAt.toISOString(),
  }));
}
