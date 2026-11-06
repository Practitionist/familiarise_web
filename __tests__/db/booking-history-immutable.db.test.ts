/** The history trigger frees only rows older than three years; real Postgres, disposable CI database only. */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";

const DAY = 86_400_000;

const seedRow = (ageDays: number) =>
  prisma.bookingStatusHistory.create({
    data: {
      entity: "CONSULTATION",
      entityId: randomUUID(),
      fromStatus: "SCHEDULED",
      toStatus: "PENDING",
      createdAt: new Date(Date.now() - ageDays * DAY),
    },
  });

it("deletes a row older than three years", async () => {
  const old = await seedRow(4 * 365);
  await prisma.bookingStatusHistory.delete({ where: { id: old.id } });
  expect(
    await prisma.bookingStatusHistory.findUnique({ where: { id: old.id } }),
  ).toBeNull();
});

it("refuses to delete a recent row", async () => {
  const recent = await seedRow(2 * 365);
  await expect(
    prisma.bookingStatusHistory.delete({ where: { id: recent.id } }),
  ).rejects.toThrow(/immutable \(DELETE refused\)/);
});

it("refuses to update an audit column, even on an old row", async () => {
  const old = await seedRow(4 * 365);
  await expect(
    prisma.bookingStatusHistory.update({
      where: { id: old.id },
      data: { toStatus: "COMPLETED" },
    }),
  ).rejects.toThrow(/immutable \(UPDATE refused\)/);
});
