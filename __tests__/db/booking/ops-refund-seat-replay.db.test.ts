/**
 * The issue door's partial refund keeps the webinar seat, and resending its key
 * with no amount replays that refund with the seat still live: the real refund
 * writer stores the seat decision on the row and the replay reads it back.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { seedUser } from "../seed";
import { refundDoor } from "./harness-edges";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

const mockAdmin = { id: "" };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireBackofficeSurface: async () => ({
    session: {
      user: { id: mockAdmin.id, role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  }),
}));
jest.mock("../../../lib/backoffice/money-limit", () => ({
  __esModule: true,
  assertMoneyOpsBudget: jest.fn(async () => undefined),
}));
const mockCreateRefund = jest.fn(async (params: { amount: number }) => ({
  refundId: `rfnd_dbtier_${randomUUID()}`,
  amount: params.amount,
  currency: "INR",
  status: "SUCCEEDED" as const,
}));
jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createRefund: (params: { amount: number }) => mockCreateRefund(params),
}));
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
const mockRevokeSeat = jest.fn(async () => undefined);
jest.mock("../../../lib/stream/access-revocation", () => ({
  persistRefundRevocation: jest.fn(async () => undefined),
  persistRefundRevocationInTx: jest.fn(async () => null),
  revokeRefundedSeatAccess: () => mockRevokeSeat(),
}));

import { POST as issueRefund } from "../../../app/api/admin/refunds/issue/route";

beforeAll(async () => {
  mockAdmin.id = (await seedUser("ADMIN")).userId;
});
beforeEach(() => {
  const writer = jest.requireActual(
    "../../../lib/payments/operations/booking-refund",
  ) as { refundBookingPayment: (...a: unknown[]) => unknown };
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(
    writer.refundBookingPayment,
  );
});

const issue = (body: Record<string, unknown>) =>
  issueRefund(
    new NextRequest("https://x.test/api/admin/refunds/issue", {
      method: "POST",
      body: JSON.stringify({ reason: "goodwill for a late start", ...body }),
    }),
    { params: Promise.resolve({}) },
  );

it("resending a ₹100 partial refund's key with no amount replays it and keeps the ₹500 seat", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  const idempotencyKey = randomUUID();

  const first = await issue({
    paymentId: payment.id,
    idempotencyKey,
    amountPaise: 10_000,
  });
  expect(first.status).toBe(200);
  const { result } = (await first.json()) as { result: { refundId: string } };

  const replay = await issue({ paymentId: payment.id, idempotencyKey });
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { result: unknown }).result).toMatchObject({
    refundId: result.refundId,
    amountRefundedPaise: 10_000,
  });

  const refunds = await prisma.refund.findMany({
    where: { paymentId: payment.id },
    select: { amountPaise: true, status: true, metadata: true },
  });
  expect(
    refunds.map((r) => ({ ...r, amountPaise: Number(r.amountPaise) })),
  ).toEqual([
    expect.objectContaining({
      amountPaise: 10_000,
      status: "SUCCEEDED",
      metadata: expect.objectContaining({ endsSeat: false }),
    }),
  ]);
  expect(mockCreateRefund).toHaveBeenCalledTimes(1);
  expect(mockRevokeSeat).not.toHaveBeenCalled();
  expect(
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
      select: { status: true },
    }),
  ).toEqual({ status: "CONFIRMED" });
});
