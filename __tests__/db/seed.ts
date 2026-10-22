/** Seeding and interleaving helpers for the database tier; every row is UUID-scoped to its test. */
import { randomUUID } from "node:crypto";
import { Prisma, type UserRole } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  createOrReuseSupportCase,
  type CreateSupportCaseInput,
} from "../../lib/support/case-service";

export async function seedUser(role: UserRole = "CONSULTEE") {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      name: `Database tier ${role.toLowerCase()}`,
      email: `${id}@db-tier.example.invalid`,
      role,
    },
  });
  return { userId: id, role };
}

export function intakeFor(
  requesterUserId: string,
  overrides: Partial<CreateSupportCaseInput> = {},
): CreateSupportCaseInput {
  return {
    title: "Database tier request",
    description: "Opened by the database tier",
    category: "GENERAL",
    requesterUserId,
    submitterUserId: requesterUserId,
    ...overrides,
  };
}

export async function seedCase(
  requesterUserId: string,
  overrides: Partial<CreateSupportCaseInput> = {},
) {
  const { supportCase } = await createOrReuseSupportCase(
    intakeFor(requesterUserId, overrides),
  );
  return supportCase;
}

/** The case's current `updatedAt`, as the compare-and-set token writers send. */
export async function caseVersion(caseId: string): Promise<string> {
  const row = await prisma.supportCase.findUniqueOrThrow({
    where: { id: caseId },
    select: { updatedAt: true },
  });
  return row.updatedAt.toISOString();
}

export const lockCaseRow = (caseId: string) =>
  Prisma.sql`SELECT id FROM "SupportCase" WHERE id = ${caseId} FOR UPDATE`;

export const lockRecommendationRow = (recommendationId: string) =>
  Prisma.sql`SELECT id FROM "SupportFinancialRecommendation" WHERE id = ${recommendationId} FOR UPDATE`;

/** Locks this IST year's reference counter, creating it first, the way `allocateTicketReference` keys it. */
export async function lockReferenceCounter() {
  const year = new Date(Date.now() + 330 * 60_000).getUTCFullYear();
  await prisma.supportCaseCounter.upsert({
    where: { year },
    create: { year },
    update: {},
  });
  return Prisma.sql`SELECT year FROM support_case_counters WHERE year = ${year} FOR UPDATE`;
}

async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= count) return;
    if (Date.now() > deadline)
      throw new Error(`Only ${waiting} of ${count} racers reached the lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Starts every racer while another transaction holds `lock`, and releases it
 * only once all of them are queued behind it: each racer has done its reads
 * before any of them writes, so the race is the same on every run.
 */
export async function raceBehindLock<T>(
  lock: Prisma.Sql,
  racers: (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  let raced: Promise<PromiseSettledResult<T>[]> | undefined;
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(lock);
      raced = Promise.allSettled(racers.map((racer) => racer()));
      await waitForLockWaiters(racers.length);
    },
    { timeout: 20_000 },
  );
  if (!raced) throw new Error("The racers never started");
  return raced;
}

/** The row id from a `performCaseAction` result, whose type spans every action. */
export function rowId(result: object): string {
  if (!("id" in result) || typeof result.id !== "string")
    throw new Error("Expected the action to return a row");
  return result.id;
}

export function settledValues<T>(results: PromiseSettledResult<T>[]) {
  return {
    fulfilled: results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
    rejected: results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    ),
  };
}
