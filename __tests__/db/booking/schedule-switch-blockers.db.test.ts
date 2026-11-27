/**
 * The Weekly/Custom switch is blocked only by bookings that still need the
 * expert's hours: a session ahead, or a paid or approved booking (or a class)
 * with nothing placed yet. The pre-flight route and the save's in-transaction
 * check read the same rows.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  seedPaidSubscription,
  type SeededHost,
} from "./harness";

const sessionUser = { current: { id: "" } as Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({ user: sessionUser.current }),
}));

import { GET as canSwitch } from "../../../app/api/user/consultants/[id]/can-switch-schedule/route";
import { checkActiveAppointments } from "../../../lib/booking/active-appointments";

const pastWindow = () => {
  const startsAt = new Date(Date.now() - 5 * 24 * HOUR_MS);
  startsAt.setUTCMinutes(0, 0, 0);
  return { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) };
};
const futureWindow = () => {
  const startsAt = futureAt(4, 9);
  return { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) };
};
const paid = { status: "SUCCEEDED" as const, expiresAt: null };

/** What the route answers and what the save's transaction counts, for one host. */
async function bothReads(host: SeededHost) {
  sessionUser.current = { id: host.userId };
  const res = await canSwitch(
    new NextRequest(
      `http://localhost/api/user/consultants/${host.consultantProfileId}/can-switch-schedule`,
    ),
    { params: Promise.resolve({ id: host.consultantProfileId }) },
  );
  const route = (await res.json()) as { canSwitch: boolean; details?: string };
  const inTx = await prisma.$transaction((tx) =>
    checkActiveAppointments(host.consultantProfileId, tx, "scheduleSwitch"),
  );
  expect(route.canSwitch).toBe(!inTx.hasActive);
  expect(route.details).toBe(inTx.details);
  return route;
}

/** A SCHEDULED class with a session at each of `starts` (none: not yet scheduled). */
async function seedClass(host: SeededHost, starts: Date[]) {
  const plan = await prisma.classPlan.create({
    data: {
      title: "Database tier class",
      price: BigInt(10_000),
      totalSessions: Math.max(starts.length, 1),
      consultantProfileId: host.consultantProfileId,
    },
  });
  const cls = await prisma.class.create({
    data: { classPlanId: plan.id, status: "SCHEDULED" },
  });
  if (starts.length === 0) return;
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "CLASS", classId: cls.id },
  });
  await prisma.appointmentOccurrence.createMany({
    data: starts.map((startsAt, i) => ({
      appointmentId: appointment.id,
      ordinal: i + 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      isTentative: false,
      consultantProfileId: host.consultantProfileId,
      completionStatus: "COMPLETED" as const,
    })),
  });
}

describe("the Weekly/Custom switch", () => {
  it("is open when a paid consultation's only session is in the past", async () => {
    const host = await seedHost();
    await seedOneToOne(
      "consultation",
      host,
      await seedConsultee(),
      pastWindow(),
      { status: "APPROVED", isTentative: false, payment: paid },
    );
    expect(await bothReads(host)).toEqual(
      expect.objectContaining({ canSwitch: true }),
    );
  });

  it("is blocked by a consultation with a session ahead", async () => {
    const host = await seedHost();
    await seedOneToOne(
      "consultation",
      host,
      await seedConsultee(),
      futureWindow(),
      { status: "APPROVED", isTentative: false, payment: paid },
    );
    expect((await bothReads(host)).details).toBe(
      "1 consultation with a session ahead or still to be placed",
    );
  });

  it("is blocked by a paid plan with no session placed yet", async () => {
    const host = await seedHost();
    await seedPaidSubscription(host, await seedConsultee(), futureAt(1, 0));
    expect((await bothReads(host)).details).toBe(
      "1 subscription with a session ahead or still to be placed",
    );
  });

  it("is blocked by a class with no sessions yet, and not by one whose sessions are all past", async () => {
    const host = await seedHost();
    const { startsAt } = pastWindow();
    await seedClass(host, [
      new Date(startsAt.getTime() - 7 * 24 * HOUR_MS),
      startsAt,
    ]);
    expect((await bothReads(host)).canSwitch).toBe(true);

    await seedClass(host, []);
    expect((await bothReads(host)).details).toBe(
      "1 class with a session ahead or still to be scheduled",
    );
  });
});
