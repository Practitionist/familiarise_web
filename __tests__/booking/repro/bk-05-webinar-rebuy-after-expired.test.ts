/**
 * @jest-environment node
 */

// Invariant: re-buying a webinar seat after an EXPIRED payment never 500s; the dead row is re-minted in place and its old order is tombstoned.

import "../../booking-algorithm/setup";
import {
  buildCheckoutInput,
  buyerRow,
  eventPlanLookup,
  mintOrder,
  mockCreatePaymentIntent as createPaymentIntent,
  silenceConsole,
  webinar,
} from "./checkout-harness/mocks/setup";
import { Prisma } from "@prisma/client";

jest.mock("../../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  ensurePlatformCancellationPolicy: jest.fn(async () => undefined),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { calls, overrides, resetDouble } from "./checkout-harness/setup";

type Row = Record<string, unknown>;
let payments: Row[] = [];

const APPT = "appt-webinar";
const BUYER = "buyer";
const OLD_INTENT = "order_OLD";

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["userId", "appointmentId"] },
  });

const input = buildCheckoutInput({
  appointmentType: "WEBINAR",
  planId: "wplan-1",
  eventId: "web-1",
});

type Outcome = {
  value: Awaited<ReturnType<typeof handleCheckout>> | null;
  error: unknown;
};

beforeEach(() => {
  payments = [
    {
      id: "pay-dead",
      userId: BUYER,
      appointmentId: APPT,
      paymentIntent: OLD_INTENT,
      paymentStatus: "EXPIRED",
    },
  ];
  mintOrder("order_NEW");
  resetDouble({
    "user.findUnique": () => buyerRow(BUYER),
    "webinar.findUnique": () => webinar,
    "webinarPlan.findUnique": eventPlanLookup,
    // Mirrors @@unique([userId, appointmentId]); NULL appointmentId never collides.
    "payment.create": (args) => {
      const data = (args as { data: Row }).data;
      const clash =
        data.appointmentId &&
        payments.some(
          (p) =>
            p.userId === data.userId && p.appointmentId === data.appointmentId,
        );
      if (clash) throw p2002();
      const row = { id: `pay-${payments.length}`, ...data };
      payments.push(row);
      return row;
    },
    "payment.findFirst": (args) => {
      const where = (args as { where?: Row }).where ?? {};
      return (
        payments.find(
          (p) =>
            (!where.userId || p.userId === where.userId) &&
            (!where.appointmentId || p.appointmentId === where.appointmentId),
        ) ?? null
      );
    },
    "payment.update": (args) => {
      const { where, data } = args as { where: { id: string }; data: Row };
      const row = payments.find((p) => p.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
    // Honours every WHERE field, `{ in: [...] }` included, so a stale CAS matches nothing.
    "payment.updateMany": (args) => {
      const { where, data } = args as { where: Row; data: Row };
      const hit = payments.filter((p) =>
        Object.entries(where).every(([field, expected]) =>
          typeof expected === "object" &&
          expected !== null &&
          "in" in expected &&
          Array.isArray(expected.in)
            ? expected.in.includes(p[field])
            : p[field] === expected,
        ),
      );
      hit.forEach((p) => Object.assign(p, data));
      return { count: hit.length };
    },
  });
  silenceConsole();
});
afterEach(() => jest.restoreAllMocks());

const run = () =>
  handleCheckout(input, BUYER).then(
    (value): Outcome => ({ value, error: null }),
    (error: unknown): Outcome => ({ value: null, error }),
  );

describe("re-buying a webinar seat after an EXPIRED payment on the same appointment", () => {
  it("never surfaces an unmapped error: success, or a typed 409", async () => {
    const { error } = await run();
    if (error === null) return;
    expect(error).toMatchObject({ httpStatus: 409, code: expect.any(String) });
  });

  it("re-mints the dead row in place and tombstones the old order with appointmentId null", async () => {
    const { value, error } = await run();
    expect(error).toBeNull();
    expect(value).not.toBeNull();

    const dead = payments.find((p) => p.id === "pay-dead");
    expect(dead?.paymentIntent).toBe("order_NEW");
    expect(dead?.paymentStatus).toBe("PENDING");

    const tombstone = payments.find((p) => p.paymentIntent === OLD_INTENT);
    expect(tombstone).toMatchObject({
      paymentStatus: "EXPIRED",
      appointmentId: null,
    });
    // The buyer is re-seated on the shared webinar appointment, held until capture.
    const seat = calls.find(
      (c) => c.path === "appointmentParticipant.createMany",
    );
    expect(seat?.args).toMatchObject({
      data: [
        {
          appointmentId: APPT,
          userId: BUYER,
          role: "CONSULTEE",
          status: "HELD",
        },
      ],
    });
  });
});

describe("the other prior-row shapes on the same seat", () => {
  it("re-mints a FAILED row in place the same way", async () => {
    payments[0].paymentStatus = "FAILED";
    const { error } = await run();
    expect(error).toBeNull();
    expect(payments[0]).toMatchObject({
      paymentIntent: "order_NEW",
      paymentStatus: "PENDING",
    });
  });

  it("refuses a fully refunded seat with a typed 409 before any gateway order", async () => {
    Object.assign(payments[0], {
      paymentStatus: "SUCCEEDED",
      amount: 100_000,
      refunds: [{ amountPaise: 100_000 }],
    });
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "SEAT_REBUY_UNSUPPORTED",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(payments).toHaveLength(1);
  });

  it("a settled seat with no prior payment refuses ALREADY_REGISTERED before any gateway order", async () => {
    payments = [];
    overrides["webinar.findUnique"] = () => ({
      ...webinar,
      appointment: {
        ...webinar.appointment,
        participants: [{ userId: BUYER, status: "CONFIRMED" }],
      },
    });
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "ALREADY_REGISTERED",
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("a zero-amount settled seat is not described as refunded", async () => {
    Object.assign(payments[0], { paymentStatus: "SUCCEEDED", amount: 0 });
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "ALREADY_REGISTERED",
    });
  });

  it("two re-buys that read the same EXPIRED row: only one claims it, the other answers 409", async () => {
    // Both attempts read the row before either CAS committed.
    const staleRead = { ...payments[0] };
    overrides["payment.findFirst"] = () => ({ ...staleRead });

    const first = await run();
    const second = await run();

    expect(first.error).toBeNull();
    expect(second.error).toMatchObject({
      httpStatus: 409,
      code: "PAYMENT_ALREADY_EXISTS",
    });
    expect(payments[0]).toMatchObject({
      paymentIntent: "order_NEW",
      paymentStatus: "PENDING",
    });
    expect(payments.filter((p) => p.paymentIntent === OLD_INTENT)).toHaveLength(
      1,
    );
  });

  it("answers a raced P2002 on (userId, appointmentId) with a typed 409", async () => {
    // A sibling checkout committed after this one's read: the insert collides.
    overrides["payment.findFirst"] = () => null;
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "PAYMENT_ALREADY_EXISTS",
    });
  });
});

describe("rejoining a free webinar seat its holder left", () => {
  it("answers with the earlier payment and its own stored intent, writing no new payment", async () => {
    const freeWebinar = {
      ...webinar,
      webinarPlan: { ...webinar.webinarPlan, price: 0 },
    };
    overrides["webinar.findUnique"] = () => freeWebinar;
    payments = [
      {
        id: "pay-free",
        userId: BUYER,
        appointmentId: APPT,
        paymentIntent: "free_first_registration",
        paymentStatus: "SUCCEEDED",
        amount: 0,
        originalAmount: 0,
        refunds: [],
        appointmentParticipants: [
          { id: "part-1", status: "CANCELLED", removedByUserId: null },
        ],
      },
    ];
    // Its holder's own leave is the seat's latest SEAT row.
    overrides["bookingStatusHistory.findMany"] = () => [
      { entityId: "part-1", reason: "self_leave" },
    ];

    const { value, error } = await run();

    expect(error).toBeNull();
    expect(value).toMatchObject({
      paymentId: "pay-free",
      paymentIntent: { id: "free_first_registration", client_secret: null },
      isZeroAmountPayment: true,
    });
    expect(payments).toHaveLength(1);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });
});
