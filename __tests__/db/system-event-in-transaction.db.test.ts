/** A system-event insert that fails inside a transaction fails that transaction; real Postgres, disposable CI database only. */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import {
  recordSystemErrorSafe,
  recordSystemEventSafe,
} from "../../lib/enterprise/system-events";

/** No such organisation: the foreign key refuses the insert and Postgres aborts the transaction. */
const MISSING_ORG = `missing-org-${randomUUID()}`;

const marker = (correlationId: string) =>
  prisma.systemEvent.findFirst({ where: { correlationId } });

it("rethrows on the transaction client and commits nothing the transaction wrote", async () => {
  const correlationId = `dbtier-tx-event-${randomUUID()}`;

  await expect(
    prisma.$transaction(async (tx) => {
      await tx.systemEvent.create({
        data: { category: "CRON", message: "written before", correlationId },
      });
      await recordSystemErrorSafe({
        organizationId: MISSING_ORG,
        category: "PAYMENT",
        summary: "forced failure",
        err: new Error("boom"),
        db: tx,
      });
    }),
  ).rejects.toBeDefined();

  expect(await marker(correlationId)).toBeNull();
});

it("the plain-event writer rethrows on the transaction client too", async () => {
  const correlationId = `dbtier-tx-event-${randomUUID()}`;

  await expect(
    prisma.$transaction(async (tx) => {
      await tx.systemEvent.create({
        data: { category: "CRON", message: "written before", correlationId },
      });
      await recordSystemEventSafe({
        organizationId: MISSING_ORG,
        category: "PAYMENT",
        message: "forced failure",
        db: tx,
      });
    }),
  ).rejects.toBeDefined();

  expect(await marker(correlationId)).toBeNull();
});

it("stays best effort on the global client: the failed insert is swallowed", async () => {
  await expect(
    recordSystemEventSafe({
      organizationId: MISSING_ORG,
      category: "PAYMENT",
      message: "forced failure",
    }),
  ).resolves.toBeUndefined();
});
