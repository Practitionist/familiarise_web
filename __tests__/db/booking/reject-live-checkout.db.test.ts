/**
 * A decline waits for the buyer's own live checkout, like an approval: on
 * both request doors, rejecting a direct checkout still being paid answers
 * 409 CHECKOUT_IN_PROGRESS and leaves the booking untouched.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/novu/service", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { PATCH as patchConsultation } from "../../../app/api/bookings/consultations/[consultationId]/route";
import { PATCH as patchSubscription } from "../../../app/api/bookings/subscriptions/[subscriptionId]/route";

const patch = (url: string) =>
  new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify({ status: "REJECTED" }),
    headers: { "Content-Type": "application/json" },
  });

describe.each(["consultation", "subscription"] as const)(
  "rejecting a %s while its buyer is paying",
  (kind) => {
    it("answers 409 CHECKOUT_IN_PROGRESS and changes nothing", async () => {
      const host = await seedHost();
      const buyer = await seedConsultee();
      const startsAt = futureAt(4, 10);
      const booking = await seedOneToOne(
        kind,
        host,
        buyer,
        { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
        {
          status: "PENDING",
          bookingSource: "DIRECT_CHECKOUT",
          isTentative: true,
          payment: {
            status: "PENDING",
            expiresAt: new Date(Date.now() + 20 * 60_000),
          },
        },
      );
      sessionUser.current = {
        id: host.userId,
        role: "CONSULTANT",
        consultantProfileId: host.consultantProfileId,
        consulteeProfileId: null,
        name: "Host",
      };

      const res =
        kind === "consultation"
          ? await patchConsultation(
              patch(
                `http://localhost/api/bookings/consultations/${booking.consultationId}`,
              ),
              {
                params: Promise.resolve({
                  consultationId: booking.consultationId ?? "",
                }),
              },
            )
          : await patchSubscription(
              patch(
                `http://localhost/api/bookings/subscriptions/${booking.subscriptionId}`,
              ),
              {
                params: Promise.resolve({
                  subscriptionId: booking.subscriptionId ?? "",
                }),
              },
            );

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("CHECKOUT_IN_PROGRESS");
      const status =
        kind === "consultation"
          ? (
              await prisma.consultation.findUniqueOrThrow({
                where: { id: booking.consultationId ?? "" },
                select: { status: true },
              })
            ).status
          : (
              await prisma.subscription.findUniqueOrThrow({
                where: { id: booking.subscriptionId ?? "" },
                select: { status: true },
              })
            ).status;
      expect(status).toBe("PENDING");
    });
  },
);
