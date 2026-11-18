/**
 * A plan editor's move and a team change on the same plan, in two sessions.
 * The editor takes its calendar batch for the team it read, then queues behind
 * the accept on the plan row; once the accept commits it reads a member whose
 * calendar it never held and refuses, with no session moved. Real Postgres,
 * disposable CI database only.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { futureAt, seedHost, untilLockWaiter } from "./harness";
import { seedWebinar } from "./harness-seats";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/email", () => {
  const noop = jest.fn(async () => ({ success: true }));
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);
const sessionUser = { current: { id: "" } as Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({ user: sessionUser.current }),
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));

import { PATCH as patchWebinar } from "../../../app/api/bookings/webinars/crud-with-plan/route";
import { lockPlanRow } from "../../../lib/collaborators/team";

describe("a plan editor's move", () => {
  it("queued behind a simultaneous accept on the plan is refused, and no session moves", async () => {
    const webinar = await seedWebinar({
      capacity: 20,
      startsAt: futureAt(6, 9),
    });
    const invitee = await seedHost();
    const pending = await prisma.collaborator.create({
      data: {
        consultantProfileId: invitee.consultantProfileId,
        collaboratorType: "WEBINAR",
        webinarPlanId: webinar.planId,
        role: "GUEST_SPEAKER",
        tier: "CREW",
        revenueShareBps: 1000,
      },
    });
    sessionUser.current = { id: webinar.host.userId };
    const move = () =>
      patchWebinar(
        new NextRequest("https://x.test/api/bookings/webinars/crud-with-plan", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: webinar.planId,
            webinarId: webinar.webinarId,
            scheduledAt: futureAt(9, 14).toISOString(),
          }),
        }),
      );

    // The accept holds the plan row as every team change does. The editor
    // starts meanwhile: it reads a team without the invitee, takes its batch
    // and waits on the plan row until the accept commits.
    let moved: Promise<Response> | undefined;
    await prisma.$transaction(
      async (tx) => {
        await lockPlanRow(tx, { planType: "webinar", planId: webinar.planId });
        await tx.collaborator.update({
          where: { id: pending.id },
          data: { status: "ACCEPTED" },
        });
        moved = move();
        await untilLockWaiter();
      },
      { timeout: 20_000 },
    );
    if (!moved) throw new Error("The editor never started");
    const response = await moved;

    expect(response.status).toBe(409);
    const sessions = await prisma.appointmentOccurrence.findMany({
      where: { appointmentId: webinar.appointmentId },
    });
    expect(sessions.map((s) => s.startsAt)).toEqual([webinar.startsAt]);
  });
});
