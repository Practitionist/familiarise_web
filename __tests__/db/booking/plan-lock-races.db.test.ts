/**
 * One plan, one queue: a writer that changes a webinar or class plan's session
 * times takes the plan row before it reads the team, so a host re-time and a
 * team change on the same plan never read each other's stale state. Real
 * Postgres, disposable CI database only.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { raceBehindLock, settledValues } from "../seed";
import { futureAt, seedHost } from "./harness";
import { seedWebinar } from "./harness-seats";

jest.mock("../../../lib/novu/service", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { notifyAppointmentRescheduled } from "../../../lib/novu/service";
import { retimeWebinar } from "../../../lib/booking/event-retime";
import {
  HostTimeHeldError,
  lockPlanForMove,
} from "../../../lib/booking/host-slot-batch";
import { currentTeam, lockPlanRow } from "../../../lib/collaborators/team";

const invite = (planId: string, consultantProfileId: string) =>
  prisma.collaborator.create({
    data: {
      consultantProfileId,
      collaboratorType: "WEBINAR",
      webinarPlanId: planId,
      role: "GUEST_SPEAKER",
      tier: "CREW",
      revenueShareBps: 1000,
    },
  });

const accept = (id: string) =>
  prisma.collaborator.update({ where: { id }, data: { status: "ACCEPTED" } });

/** The accept as one statement: the caps trigger takes the plan row with it. */
const acceptHoldingThePlanRow = (collaboratorId: string) =>
  Prisma.sql`UPDATE "Collaborator" SET "status" = 'ACCEPTED' WHERE "id" = ${collaboratorId} RETURNING "id"`;

describe("a webinar re-time", () => {
  it("tells the plan's team, with no leave offer and not as a required notice", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const member = await seedHost();
    await accept((await invite(webinar.planId, member.consultantProfileId)).id);
    const newStart = futureAt(9, 14);
    jest.mocked(notifyAppointmentRescheduled).mockClear();

    await retimeWebinar({
      appointmentId: webinar.appointmentId,
      startsAt: newStart,
      actorUserId: webinar.host.userId,
    });

    const toTeam = jest
      .mocked(notifyAppointmentRescheduled)
      .mock.calls.filter(([recipients]) => recipients.includes(member.userId));
    expect(toTeam).toHaveLength(1);
    const [recipients, payload, options] = toTeam[0];
    expect(recipients).toEqual([member.userId]);
    expect(payload).toMatchObject({
      outcome: "MOVED",
      newDateTime: newStart.toISOString(),
    });
    expect(payload).not.toHaveProperty("leaveBy");
    expect(options).not.toHaveProperty("required");
  });
});

describe("the plan lock", () => {
  it("keeps every value of a webinar plan and a class plan", async () => {
    const { planId, host } = await seedWebinar();
    const classPlan = await prisma.classPlan.create({
      data: {
        title: `Database tier class ${randomUUID().slice(0, 8)}`,
        price: BigInt(10_000),
        totalSessions: 4,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const before = {
      webinar: await prisma.webinarPlan.findUniqueOrThrow({
        where: { id: planId },
      }),
      class: await prisma.classPlan.findUniqueOrThrow({
        where: { id: classPlan.id },
      }),
    };

    await prisma.$transaction(async (tx) => {
      await lockPlanRow(tx, { planType: "webinar", planId });
      await lockPlanRow(tx, { planType: "class", planId: classPlan.id });
    });

    expect(
      await prisma.webinarPlan.findUniqueOrThrow({ where: { id: planId } }),
    ).toEqual(before.webinar);
    expect(
      await prisma.classPlan.findUniqueOrThrow({ where: { id: classPlan.id } }),
    ).toEqual(before.class);
  });

  it("refuses a move whose slot batch missed a member of the team", async () => {
    const { planId, host } = await seedWebinar();
    const member = await seedHost();
    await accept((await invite(planId, member.consultantProfileId)).id);

    await expect(
      prisma.$transaction((tx) =>
        lockPlanForMove(tx, "WEBINAR", planId, [host.consultantProfileId]),
      ),
    ).rejects.toBeInstanceOf(HostTimeHeldError);
    await expect(
      prisma.$transaction((tx) =>
        lockPlanForMove(tx, "WEBINAR", planId, [
          host.consultantProfileId,
          member.consultantProfileId,
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it("queues a simultaneous host re-time and team read behind a team change on the plan", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const invitee = await seedHost();
    const pending = await invite(webinar.planId, invitee.consultantProfileId);
    const newStart = futureAt(9, 14);

    const teamRead = () =>
      prisma.$transaction(async (tx) => {
        await lockPlanRow(tx, { planType: "webinar", planId: webinar.planId });
        return currentTeam(tx, {
          planType: "webinar",
          planId: webinar.planId,
        });
      });
    const retime = () =>
      retimeWebinar({
        appointmentId: webinar.appointmentId,
        startsAt: newStart,
        actorUserId: webinar.host.userId,
      });

    // Both racers reach the plan row while the accept still holds it; they run
    // only after it commits.
    const [moved, team] = await raceBehindLock<unknown>(
      acceptHoldingThePlanRow(pending.id),
      [retime, teamRead],
    );

    // The re-time took its slot batch before the invitee was on the team, so
    // behind the lock it sees a member whose calendar it never held.
    expect(settledValues([moved]).rejected).toEqual([
      expect.any(HostTimeHeldError),
    ]);
    expect(settledValues([team]).fulfilled).toEqual([
      [
        expect.objectContaining({
          consultantProfileId: invitee.consultantProfileId,
        }),
      ],
    ]);
    const session = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId },
    });
    expect(session.startsAt).toEqual(webinar.startsAt);
    expect(session.movedAt).toBeNull();
  });
});
