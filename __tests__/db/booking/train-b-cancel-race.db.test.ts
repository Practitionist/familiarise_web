/**
 * A support refund that takes sessions off a plan while a cancel is quoting
 * it, on real Postgres. The cancel's CAS is pinned to the removed-session
 * count it read, so it re-quotes instead of paying those sessions again.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { removePlanSessions } from "../../../lib/booking/plan-refund";
import { seedConsultee, seedHost, seedPaidSubscription } from "./harness";
import { refundDoor, sessionUser } from "./harness-edges";

jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-edges").authHelpersMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);

/** Runs once, right after the cancel read its quote inputs. */
const racer: { run: null | (() => Promise<void>) } = { run: null };
jest.mock("../../../lib/booking/cancellation-scope", () => {
  const actual = jest.requireActual("../../../lib/booking/cancellation-scope");
  return {
    ...actual,
    resolveBookingRefundContext: async (...args: unknown[]) => {
      const ctx = await actual.resolveBookingRefundContext(...args);
      const run = racer.run;
      racer.run = null;
      if (run) await run();
      return ctx;
    },
  };
});

import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";

const postCancel = (appointmentId: string, body: unknown) =>
  cancel(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );

it("re-quotes when a support refund removed sessions mid-cancel", async () => {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const { subscriptionId, appointmentId } = await seedPaidSubscription(
    host,
    buyer,
    new Date(Date.now() + 2 * 86_400_000),
  );
  const payment = await prisma.payment.findFirstOrThrow({
    where: { appointmentId },
  });
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(
    async (args: { amountPaise?: number }) => ({
      refundId: "rf_race",
      amountRefundedPaise: args.amountPaise ?? 0,
      status: "SUCCEEDED",
    }),
  );

  // 8 unheld sessions at ₹500: the dialog shows ₹4,000.
  racer.run = async () => {
    const change = await prisma.$transaction((tx) =>
      removePlanSessions(tx, payment.id, 3),
    );
    expect(change).toMatchObject({ ok: true, sessionsRefunded: 3 });
  };
  const raced = await postCancel(appointmentId, {
    reason: "SCHEDULE_CONFLICT",
    expectedRefundPaise: 400_000,
  });
  expect(raced.status).toBe(409);
  expect(await raced.json()).toMatchObject({ code: "REFUND_QUOTE_CHANGED" });
  expect(refundDoor.refundBookingPayment).not.toHaveBeenCalled();
  const still = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  expect(still.status).not.toBe("CANCELLED");

  // Confirming the new figure cancels at the 5 sessions left: ₹2,500.
  const confirmed = await postCancel(appointmentId, {
    reason: "SCHEDULE_CONFLICT",
    expectedRefundPaise: 250_000,
  });
  expect(confirmed.status).toBe(200);
  expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
    expect.objectContaining({ paymentId: payment.id, amountPaise: 250_000 }),
  );
});
