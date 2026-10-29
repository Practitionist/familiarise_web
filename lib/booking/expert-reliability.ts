/**
 * Expert reliability strikes: one SystemEvent per expert-side cancel of a paid
 * booking or consultant no-show, on the `expert-reliability:` correlation (the
 * class-series flag keeps its own `class-reliability:` one). No money moves.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";

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
    /** The judged session, when the strike is about one particular occurrence. */
    occurrenceId?: string;
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
        ...(args.occurrenceId ? { occurrenceId: args.occurrenceId } : {}),
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
  occurrenceId: z.string().optional(),
});
type StrikeContext = z.infer<typeof strikeContextSchema>;

const strikeContextOf = (context: Prisma.JsonValue): StrikeContext | null => {
  const parsed = strikeContextSchema.safeParse(context);
  return parsed.success ? parsed.data : null;
};

type IncidentWindow = { startsAt: Date; endsAt: Date };

async function incidentWindows(
  db: StrikeReader,
  since: Date,
): Promise<IncidentWindow[]> {
  return db.platformIncident.findMany({
    where: { endsAt: { gt: new Date(since.getTime() - INCIDENT_LOOKBACK_MS) } },
    select: { startsAt: true, endsAt: true },
    take: 200,
  });
}

/** Appointments with a session inside a declared incident: their unscoped strikes never count. */
async function incidentAppointmentIds(
  db: StrikeReader,
  appointmentIds: string[],
  incidents: IncidentWindow[],
): Promise<Set<string>> {
  if (appointmentIds.length === 0 || incidents.length === 0) return new Set();
  const rows = await db.appointmentOccurrence.findMany({
    where: {
      appointmentId: { in: appointmentIds },
      OR: incidents.map((w) => ({
        startsAt: { lt: w.endsAt },
        endsAt: { gt: w.startsAt },
      })),
    },
    select: { appointmentId: true },
    distinct: ["appointmentId"],
  });
  return new Set(rows.map((r) => r.appointmentId));
}

/** Occurrences that themselves overlap a declared incident: their strikes never count. */
async function incidentOccurrenceIds(
  db: StrikeReader,
  occurrenceIds: string[],
  incidents: IncidentWindow[],
): Promise<Set<string>> {
  if (occurrenceIds.length === 0 || incidents.length === 0) return new Set();
  const rows = await db.appointmentOccurrence.findMany({
    where: {
      id: { in: occurrenceIds },
      OR: incidents.map((w) => ({
        startsAt: { lt: w.endsAt },
        endsAt: { gt: w.startsAt },
      })),
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** The strikes in the window, less those on a session a declared incident voided. */
async function countableStrikes<R extends { context: Prisma.JsonValue }>(
  db: StrikeReader,
  rows: R[],
  since: Date,
): Promise<R[]> {
  const contexts = rows.map((r) => strikeContextOf(r.context));
  const appointmentIds = [
    ...new Set(contexts.flatMap((c) => (c ? [c.appointmentId] : []))),
  ];
  const occurrenceIds = [
    ...new Set(
      contexts.flatMap((c) => (c?.occurrenceId ? [c.occurrenceId] : [])),
    ),
  ];
  if (appointmentIds.length === 0 && occurrenceIds.length === 0) return rows;
  const incidents = await incidentWindows(db, since);
  if (incidents.length === 0) return rows;
  const [coveredAppointments, coveredOccurrences] = await Promise.all([
    incidentAppointmentIds(db, appointmentIds, incidents),
    incidentOccurrenceIds(db, occurrenceIds, incidents),
  ]);
  if (coveredAppointments.size === 0 && coveredOccurrences.size === 0) {
    return rows;
  }
  return rows.filter((_, i) => {
    const context = contexts[i];
    if (!context) return true;
    return context.occurrenceId
      ? !coveredOccurrences.has(context.occurrenceId)
      : !coveredAppointments.has(context.appointmentId);
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
