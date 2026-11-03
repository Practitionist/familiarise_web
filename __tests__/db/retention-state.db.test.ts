/** Retention never deletes state a reader still needs; real Postgres, disposable CI database only. */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import { isWalletFrozen } from "../../lib/payments/wallet-freeze";
import { pruneSystemEvents } from "../../lib/observability/system-event-retention";
import { pruneAuditLogs } from "../../scripts/cleanup/prune-audit-logs";
import { pruneSystemJobExecutions } from "../../scripts/cleanup/prune-system-job-executions";
import { seedConsultee, seedHost, seedOneToOne } from "./booking/harness";

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

it("keeps a wallet frozen 401 days ago frozen after the event prune", async () => {
  const accountId = randomUUID();
  const correlationId = `wallet-freeze:${accountId}`;
  const event = (category: string, days: number) =>
    prisma.systemEvent.create({
      data: {
        category,
        message: "Database tier freeze history",
        correlationId,
        createdAt: daysAgo(days),
      },
    });
  const superseded = await event("WALLET_FREEZE", 450);
  await event("WALLET_UNFREEZE", 440);
  const latest = await event("WALLET_FREEZE", 401);
  const noise = await prisma.systemEvent.create({
    data: { category: "CRON", message: "aged", createdAt: daysAgo(401) },
  });

  await pruneSystemEvents({ limit: 500 });

  expect(await isWalletFrozen(prisma, accountId)).toBe(true);
  const left = await prisma.systemEvent.findMany({
    where: { id: { in: [superseded.id, latest.id, noise.id] } },
    select: { id: true },
  });
  expect(left.map((row) => row.id)).toEqual([latest.id]);
});

it("prunes a terminal booking's history after three years but never a live one's", async () => {
  const host = await seedHost();
  const consultee = await seedConsultee();
  const longAgo = daysAgo(4 * 365);
  const window = {
    startsAt: longAgo,
    endsAt: new Date(longAgo.getTime() + 3_600_000),
  };
  const live = await seedOneToOne("consultation", host, consultee, window, {
    status: "PENDING",
    isTentative: false,
  });
  // The overlap constraint covers COMPLETED rows too, so the terminal booking gets its own hour.
  const doneWindow = {
    startsAt: new Date(window.startsAt.getTime() + DAY),
    endsAt: new Date(window.endsAt.getTime() + DAY),
  };
  const done = await seedOneToOne("consultation", host, consultee, doneWindow, {
    status: "COMPLETED",
    isTentative: false,
    completionStatus: "COMPLETED",
  });
  for (const booking of [live, done]) {
    await prisma.$executeRaw`UPDATE "Consultation" SET "updatedAt" = ${longAgo} WHERE "id" = ${booking.consultationId}`;
    await prisma.$executeRaw`UPDATE "Appointment" SET "updatedAt" = ${longAgo} WHERE "id" = ${booking.appointmentId}`;
  }
  const history = (booking: typeof live) =>
    prisma.bookingStatusHistory.create({
      data: {
        appointmentId: booking.appointmentId,
        entity: "CONSULTATION",
        entityId: booking.consultationId ?? "",
        fromStatus: "SCHEDULED",
        toStatus: "PENDING",
        createdAt: longAgo,
      },
    });
  const liveOrigin = await history(live);
  const doneRow = await history(done);

  await pruneAuditLogs({ limit: 500 });

  const left = await prisma.bookingStatusHistory.findMany({
    where: { id: { in: [liveOrigin.id, doneRow.id] } },
    select: { id: true },
  });
  expect(left.map((row) => row.id)).toEqual([liveOrigin.id]);
});

it("prunes only plain old no-op runs, keeping checkpoint, idle, admin and newest runs", async () => {
  const jobName = `retention-noop-${randomUUID()}`;
  const run = (
    days: number,
    extra: { result?: object; triggeredBy?: string } = {},
  ) =>
    prisma.systemJobExecution.create({
      data: {
        jobId: jobName,
        jobName,
        status: "COMPLETED",
        startedAt: daysAgo(days),
        endedAt: daysAgo(days),
        itemsProcessed: 0,
        errorCount: 0,
        ...extra,
      },
    });
  const plain = await run(20, { result: { outcome: "completed" } });
  const checkpoint = await run(19, { result: { checkpoint: { cursor: "c" } } });
  const idle = await run(18, { result: { idle: ["some-target"] } });
  const admin = await run(17, { triggeredBy: "admin:operator" });
  const newest = await run(16);

  await pruneSystemJobExecutions({ limit: 500 });

  const left = await prisma.systemJobExecution.findMany({
    where: { jobName },
    orderBy: { startedAt: "asc" },
    select: { id: true },
  });
  expect(left.map((row) => row.id)).toEqual([
    checkpoint.id,
    idle.id,
    admin.id,
    newest.id,
  ]);
  expect(left.map((row) => row.id)).not.toContain(plain.id);
});
