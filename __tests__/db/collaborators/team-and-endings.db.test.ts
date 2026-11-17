/**
 * Two things only Postgres can show: the team as of a time is read from each
 * row's own period, and an ending writes the order to take access back in the
 * same commit as the status change. Real Postgres, disposable CI database only.
 */
import prisma from "../../../lib/prisma";
import { seedHost } from "../booking/harness";
import { seedWebinar } from "../booking/harness-seats";

jest.mock("../../../lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: jest.fn(async () => ({})),
}));
jest.mock("../../../lib/stream-client", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/event-channel-service", () => ({}));
jest.mock("../../../lib/stream/dm-eligibility", () => ({}));
jest.mock("../../../lib/stream/collaborator-access", () => ({}));
jest.mock("../../../lib/stream/conduct-call-block", () => ({}));

import { endCollaboration } from "../../../lib/collaborators/ending";
import { teamAsOf, type PlanRef } from "../../../lib/collaborators/team";

async function seedInvite() {
  const { planId } = await seedWebinar();
  const member = await seedHost();
  const row = await prisma.collaborator.create({
    data: {
      consultantProfileId: member.consultantProfileId,
      collaboratorType: "WEBINAR",
      webinarPlanId: planId,
      role: "GUEST_SPEAKER",
      tier: "CREW",
      revenueShareBps: 2000,
    },
  });
  const ref: PlanRef = { planType: "webinar", planId };
  return { ref, member, row };
}

const accept = (id: string) =>
  prisma.collaborator.update({ where: { id }, data: { status: "ACCEPTED" } });

const owedRevocations = (ref: PlanRef, userId: string) =>
  prisma.streamRevocationRetry.count({
    where: { kind: "COLLAB_REVOKE", planId: ref.planId, userId },
  });

const msBefore = (at: Date) => new Date(at.getTime() - 1);

describe("the team as of a time", () => {
  it("holds a member from the accept until the ending, whenever it is asked", async () => {
    const { ref, row } = await seedInvite();
    expect(await teamAsOf(prisma, ref, new Date())).toEqual([]);

    const { acceptedAt } = await accept(row.id);
    if (!acceptedAt) throw new Error("the accept stamped no time");
    // The two stamps must differ by more than the millisecond a Date keeps.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { endedAt } = await prisma.collaborator.update({
      where: { id: row.id },
      data: { status: "REMOVED" },
    });
    if (!endedAt) throw new Error("the removal stamped no time");

    const idsAt = async (at: Date) =>
      (await teamAsOf(prisma, ref, at)).map((m) => m.collaboratorId);
    expect(await idsAt(msBefore(acceptedAt))).toEqual([]);
    expect(await idsAt(acceptedAt)).toEqual([row.id]);
    expect(await idsAt(msBefore(endedAt))).toEqual([row.id]);
    expect(await idsAt(endedAt)).toEqual([]);
  });

  it("never holds an invitation that was declined", async () => {
    const { ref, row } = await seedInvite();
    await prisma.collaborator.update({
      where: { id: row.id },
      data: { status: "DECLINED" },
    });
    expect(await teamAsOf(prisma, ref, new Date())).toEqual([]);
  });
});

describe("an ending", () => {
  it("commits the removal of a team member together with the revocation it owes", async () => {
    const { ref, member, row } = await seedInvite();
    await accept(row.id);

    const ended = await prisma.$transaction((tx) =>
      endCollaboration(tx, {
        collaboratorId: row.id,
        to: "REMOVED",
        endedByUserId: null,
      }),
    );

    expect(ended).toMatchObject({ wasOnTeam: true, userId: member.userId });
    expect(ended?.revocationGeneration).toBeInstanceOf(Date);
    expect(ended?.collaborator).toMatchObject({ status: "REMOVED" });
    expect(await owedRevocations(ref, member.userId)).toBe(1);
  });

  it("leaves neither the removal nor the revocation when its transaction rolls back", async () => {
    const { ref, member, row } = await seedInvite();
    await accept(row.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await endCollaboration(tx, {
          collaboratorId: row.id,
          to: "REMOVED",
          endedByUserId: null,
        });
        throw new Error("the caller's transaction failed after the ending");
      }),
    ).rejects.toThrow(/failed after the ending/);

    const after = await prisma.collaborator.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("ACCEPTED");
    expect(await owedRevocations(ref, member.userId)).toBe(0);
  });

  it("owes no revocation for an invitation that was never accepted", async () => {
    const { ref, member, row } = await seedInvite();

    const ended = await prisma.$transaction((tx) =>
      endCollaboration(tx, {
        collaboratorId: row.id,
        to: "EXPIRED",
        endedByUserId: null,
      }),
    );

    expect(ended).toMatchObject({
      wasOnTeam: false,
      revocationGeneration: null,
    });
    expect(ended?.collaborator.status).toBe("EXPIRED");
    expect(await owedRevocations(ref, member.userId)).toBe(0);
  });

  it("applies once: a second ending of the same row changes nothing", async () => {
    const { ref, member, row } = await seedInvite();
    await accept(row.id);
    const end = () =>
      prisma.$transaction((tx) =>
        endCollaboration(tx, {
          collaboratorId: row.id,
          to: "WITHDRAWN",
          endedByUserId: member.userId,
        }),
      );

    expect(await end()).not.toBeNull();
    expect(await end()).toBeNull();
    expect(await owedRevocations(ref, member.userId)).toBe(1);
  });
});
