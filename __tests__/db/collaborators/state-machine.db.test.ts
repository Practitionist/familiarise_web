/**
 * The collaborator rules Postgres enforces for every writer: the state machine
 * and period stamps (collaborator_transition_guard), the team and share caps
 * (collaborator_plan_caps) and one live row per expert per plan. Real Postgres,
 * disposable CI database only.
 */
import {
  Prisma,
  type CollaboratorRole,
  type CollaboratorStatus,
} from "@prisma/client";
import prisma from "../../../lib/prisma";
import { raceBehindLock, seedUser, settledValues } from "../seed";
import { seedHost } from "../booking/harness";
import { seedWebinar } from "../booking/harness-seats";

const lockPlanRow = (planId: string) =>
  Prisma.sql`SELECT id FROM "WebinarPlan" WHERE id = ${planId} FOR NO KEY UPDATE`;

async function invite(
  planId: string,
  consultantProfileId: string,
  terms: { role?: CollaboratorRole; revenueShareBps?: number } = {},
) {
  const role = terms.role ?? "GUEST_SPEAKER";
  return prisma.collaborator.create({
    data: {
      consultantProfileId,
      collaboratorType: "WEBINAR",
      webinarPlanId: planId,
      role,
      tier: role === "CO_HOST" ? "PRESENTER" : "CREW",
      revenueShareBps: terms.revenueShareBps ?? 1000,
    },
  });
}

const move = (id: string, status: CollaboratorStatus) =>
  prisma.collaborator.update({ where: { id }, data: { status } });

const read = (id: string) =>
  prisma.collaborator.findUniqueOrThrow({ where: { id } });

async function seedPlanAndExperts(experts: number) {
  const { planId, host } = await seedWebinar();
  const invitees = [];
  for (let i = 0; i < experts; i += 1) invitees.push(await seedHost());
  return { planId, host, invitees };
}

describe("the state machine", () => {
  it("lets a row be born only as an invitation, with no period times", async () => {
    const { planId, invitees } = await seedPlanAndExperts(1);
    await expect(
      prisma.collaborator.create({
        data: {
          consultantProfileId: invitees[0].consultantProfileId,
          collaboratorType: "WEBINAR",
          webinarPlanId: planId,
          role: "GUEST_SPEAKER",
          tier: "CREW",
          revenueShareBps: 1000,
          status: "ACCEPTED",
        },
      }),
    ).rejects.toThrow(/starts as an invitation/);

    const pending = await prisma.collaborator.create({
      data: {
        consultantProfileId: invitees[0].consultantProfileId,
        collaboratorType: "WEBINAR",
        webinarPlanId: planId,
        role: "GUEST_SPEAKER",
        tier: "CREW",
        revenueShareBps: 1000,
        acceptedAt: new Date("2020-01-01T00:00:00Z"),
        endedAt: new Date("2020-01-02T00:00:00Z"),
      },
    });
    expect(pending).toMatchObject({
      status: "PENDING",
      acceptedAt: null,
      endedAt: null,
    });
  });

  it("stamps the accept, then fixes the terms", async () => {
    const { planId, invitees } = await seedPlanAndExperts(1);
    const row = await invite(planId, invitees[0].consultantProfileId);

    await prisma.collaborator.update({
      where: { id: row.id },
      data: { revenueShareBps: 2500, role: "MODERATOR" },
    });
    const accepted = await move(row.id, "ACCEPTED");
    expect(accepted.acceptedAt).toBeInstanceOf(Date);
    expect(accepted.respondedAt).toBeInstanceOf(Date);
    expect(accepted.endedAt).toBeNull();

    await expect(
      prisma.collaborator.update({
        where: { id: row.id },
        data: { revenueShareBps: 9000 },
      }),
    ).rejects.toThrow(/terms of collaboration/);
    await expect(
      prisma.collaborator.update({
        where: { id: row.id },
        data: { role: "GUEST_SPEAKER" },
      }),
    ).rejects.toThrow(/terms of collaboration/);
    await expect(move(row.id, "PENDING")).rejects.toThrow(
      /cannot go from ACCEPTED to PENDING/,
    );
    await expect(move(row.id, "DECLINED")).rejects.toThrow(
      /cannot go from ACCEPTED to DECLINED/,
    );

    await prisma.collaborator.update({
      where: { id: row.id },
      data: { acceptedAt: new Date("2001-01-01T00:00:00Z") },
    });
    expect((await read(row.id)).acceptedAt).toEqual(accepted.acceptedAt);
  });

  it("ends a row once, records who ended it, and never reopens it", async () => {
    const { planId, host, invitees } = await seedPlanAndExperts(1);
    const row = await invite(planId, invitees[0].consultantProfileId);
    const accepted = await move(row.id, "ACCEPTED");

    const removed = await prisma.collaborator.update({
      where: { id: row.id },
      data: { status: "REMOVED", endedByUserId: host.userId },
    });
    expect(removed.endedAt).toBeInstanceOf(Date);
    expect(removed.acceptedAt).toEqual(accepted.acceptedAt);

    const reopen: CollaboratorStatus[] = [
      "PENDING",
      "ACCEPTED",
      "WITHDRAWN",
      "DECLINED",
      "EXPIRED",
    ];
    for (const status of reopen) {
      await expect(move(row.id, status)).rejects.toThrow(
        /cannot go from REMOVED/,
      );
    }
    await expect(
      prisma.collaborator.update({
        where: { id: row.id },
        data: { revenueShareBps: 100 },
      }),
    ).rejects.toThrow(/terms of collaboration/);
  });

  it("lets the foreign keys clear the ender and the inviter on an ended row", async () => {
    const { planId, invitees } = await seedPlanAndExperts(1);
    const operator = await seedUser("STAFF");
    const row = await invite(planId, invitees[0].consultantProfileId);
    await prisma.collaborator.update({
      where: { id: row.id },
      data: { status: "REMOVED", endedByUserId: operator.userId },
    });

    await prisma.user.delete({ where: { id: operator.userId } });

    expect(await read(row.id)).toMatchObject({
      status: "REMOVED",
      endedByUserId: null,
    });
  });

  it("separates a decline, an expiry and a departure", async () => {
    const { planId, invitees } = await seedPlanAndExperts(3);
    const [declines, lapses, leaves] = await Promise.all(
      invitees.map((expert) => invite(planId, expert.consultantProfileId)),
    );

    await expect(move(leaves.id, "WITHDRAWN")).rejects.toThrow(
      /cannot go from PENDING to WITHDRAWN/,
    );

    const declined = await move(declines.id, "DECLINED");
    expect(declined.endedAt).toBeInstanceOf(Date);
    expect(declined.respondedAt).toBeInstanceOf(Date);
    expect(declined.acceptedAt).toBeNull();

    const expired = await move(lapses.id, "EXPIRED");
    expect(expired.endedAt).toBeInstanceOf(Date);
    expect(expired.respondedAt).toBeNull();
    expect(expired.acceptedAt).toBeNull();

    await move(leaves.id, "ACCEPTED");
    const withdrawn = await move(leaves.id, "WITHDRAWN");
    expect(withdrawn.endedAt).toBeInstanceOf(Date);
    expect(withdrawn.acceptedAt).toBeInstanceOf(Date);
  });
});

describe("one live row per expert per plan, with history kept", () => {
  it("invites again as a new row and refuses a second live row", async () => {
    const { planId, invitees } = await seedPlanAndExperts(1);
    const expert = invitees[0].consultantProfileId;
    const first = await invite(planId, expert, { revenueShareBps: 3000 });
    await move(first.id, "ACCEPTED");
    await move(first.id, "REMOVED");

    const second = await invite(planId, expert, { revenueShareBps: 1000 });
    await expect(invite(planId, expert)).rejects.toThrow(
      /Unique constraint|collaborator_one_active_webinar/,
    );

    const periods = await prisma.collaborator.findMany({
      where: { webinarPlanId: planId, consultantProfileId: expert },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, revenueShareBps: true },
    });
    expect(periods).toEqual([
      { id: first.id, status: "REMOVED", revenueShareBps: 3000 },
      { id: second.id, status: "PENDING", revenueShareBps: 1000 },
    ]);
  });

  it("commits exactly one of two simultaneous invitations to the same expert", async () => {
    const { planId, invitees } = await seedPlanAndExperts(1);
    const expert = invitees[0].consultantProfileId;

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(lockPlanRow(planId), [
        () => invite(planId, expert),
        () => invite(planId, expert),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      await prisma.collaborator.count({
        where: { webinarPlanId: planId, consultantProfileId: expert },
      }),
    ).toBe(1);
  });
});

describe("the team and share caps", () => {
  it("refuses a fourth live collaborator and frees the seat when one ends", async () => {
    const { planId, invitees } = await seedPlanAndExperts(4);
    const rows = [];
    for (const expert of invitees.slice(0, 3)) {
      rows.push(await invite(planId, expert.consultantProfileId));
    }
    await expect(
      invite(planId, invitees[3].consultantProfileId),
    ).rejects.toThrow(/at most 3 pending or accepted/);

    await move(rows[0].id, "DECLINED");
    await expect(
      invite(planId, invitees[3].consultantProfileId),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("holds live shares to 9000 basis points on an invite and on an edit", async () => {
    const { planId, invitees } = await seedPlanAndExperts(2);
    const first = await invite(planId, invitees[0].consultantProfileId, {
      revenueShareBps: 5000,
    });
    await expect(
      invite(planId, invitees[1].consultantProfileId, {
        revenueShareBps: 4001,
      }),
    ).rejects.toThrow(/9000 basis points/);

    await invite(planId, invitees[1].consultantProfileId, {
      revenueShareBps: 4000,
    });
    await expect(
      prisma.collaborator.update({
        where: { id: first.id },
        data: { revenueShareBps: 5001 },
      }),
    ).rejects.toThrow(/9000 basis points/);
  });

  it("commits exactly one of two simultaneous invitations that together pass 9000", async () => {
    const { planId, invitees } = await seedPlanAndExperts(2);

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(
        lockPlanRow(planId),
        invitees.map(
          (expert) => () =>
            invite(planId, expert.consultantProfileId, {
              revenueShareBps: 5000,
            }),
        ),
      ),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const live = await prisma.collaborator.aggregate({
      where: { webinarPlanId: planId, status: { in: ["PENDING", "ACCEPTED"] } },
      _sum: { revenueShareBps: true },
    });
    expect(live._sum.revenueShareBps).toBe(5000);
  });
});
