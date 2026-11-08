/**
 * The notify-me table against real Postgres: one row per waiter and event,
 * the sidecar CHECKs on status timestamps, and the notify compare-and-set
 * flipping each waiter exactly once when two releasers race.
 */
import prisma from "../../lib/prisma";
import { seedUser } from "./seed";

async function seedWaitlist(waiters: number) {
  // TRIAL needs no parent row under appointment_parent_matches_type; no waitlist check reads the type.
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "TRIAL" },
    select: { id: true },
  });
  const users = await Promise.all(
    Array.from({ length: waiters }, () => seedUser()),
  );
  await prisma.appointmentWaitlist.createMany({
    data: users.map(({ userId }) => ({
      appointmentId: appointment.id,
      userId,
      planKind: "WEBINAR" as const,
      planId: "db-tier-plan",
    })),
  });
  return { appointmentId: appointment.id, userIds: users.map((u) => u.userId) };
}

it("keeps one row per waiter and event", async () => {
  const { appointmentId, userIds } = await seedWaitlist(1);
  await expect(
    prisma.appointmentWaitlist.create({
      data: {
        appointmentId,
        userId: userIds[0],
        planKind: "WEBINAR",
        planId: "db-tier-plan",
      },
    }),
  ).rejects.toThrow(/Unique constraint/);
});

it("refuses NOTIFIED without notifiedAt and a non-event plan kind", async () => {
  const { appointmentId, userIds } = await seedWaitlist(1);
  await expect(
    prisma.appointmentWaitlist.updateMany({
      where: { appointmentId, userId: userIds[0] },
      data: { status: "NOTIFIED" },
    }),
  ).rejects.toThrow(/appointment_waitlist_notified_at_chk/);
  await expect(
    prisma.appointmentWaitlist.updateMany({
      where: { appointmentId, userId: userIds[0] },
      data: { planKind: "CONSULTATION" },
    }),
  ).rejects.toThrow(/appointment_waitlist_plan_kind_chk/);
});

it("flips each waiter once when two releasers notify at the same time", async () => {
  const { appointmentId, userIds } = await seedWaitlist(5);
  const now = new Date();
  const notify = () =>
    prisma.$transaction((tx) =>
      tx.appointmentWaitlist.updateManyAndReturn({
        where: { appointmentId, OR: [{ status: "WAITING" }] },
        data: { status: "NOTIFIED", notifiedAt: now },
        select: { userId: true },
      }),
    );
  const [a, b] = await Promise.all([notify(), notify()]);
  const notified = [...a, ...b].map((row) => row.userId).sort();
  expect(notified).toEqual([...userIds].sort());
});
