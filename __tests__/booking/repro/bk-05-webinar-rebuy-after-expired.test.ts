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

describe("a removal outlasts the removed seat's lapsed checkout", () => {
  // An organiser removed the buyer while their card seat was HELD: the seat is
  // CANCELLED with the mark, and order reuse has since expired the order.
  const removedSeat = {
    id: "part-1",
    status: "CANCELLED",
    removedByUserId: "host-1",
  };

  it.each(["EXPIRED", "PENDING"])(
    "refuses a %s order on a removed seat before any gateway order, and re-mints nothing",
    async (status) => {
      Object.assign(payments[0], {
        paymentStatus: status,
        amount: 100_000,
        refunds: [],
        appointmentParticipants: [removedSeat],
      });
      const { error } = await run();
      expect(error).toMatchObject({
        httpStatus: 409,
        code: "SEAT_REBUY_UNSUPPORTED",
        message: expect.stringMatching(/organiser removed you/),
      });
      expect(createPaymentIntent).not.toHaveBeenCalled();
      expect(payments[0]).toMatchObject({
        paymentIntent: OLD_INTENT,
        paymentStatus: status,
      });
    },
  );

  it("refuses an EXPIRED order on an unmarked seat whose conduct removal still stands", async () => {
    Object.assign(payments[0], {
      amount: 100_000,
      refunds: [],
      appointmentParticipants: [{ ...removedSeat, removedByUserId: null }],
    });
    overrides["supportCase.findFirst"] = () => ({
      id: "case-1",
      createdAt: new Date("2026-11-10T00:00:00Z"),
    });
    overrides["appointmentParticipant.findUnique"] = () => ({ id: "part-1" });
    const { error } = await run();
    expect(error).toMatchObject({ code: "SEAT_REBUY_UNSUPPORTED" });
    expect(payments[0]).toMatchObject({
      paymentIntent: OLD_INTENT,
      paymentStatus: "EXPIRED",
    });
  });

  it("refuses the commit when the revive moved no seat (a mark landed after the prior read)", async () => {
    // The prior read saw an unmarked lapsed seat; the row is marked by the time the commit writes.
    Object.assign(payments[0], {
      appointmentParticipants: [{ ...removedSeat, removedByUserId: null }],
    });
    overrides["appointmentParticipant.createMany"] = () => ({ count: 0 });
    overrides["appointmentParticipant.updateMany"] = (args) =>
      JSON.stringify((args as { where: unknown }).where).includes(
        '"removedByUserId":null',
      )
        ? { count: 0 }
        : { count: 1 };
    overrides["appointmentParticipant.findFirst"] = () => ({
      status: "CANCELLED",
      removedByUserId: "host-1",
    });
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/organiser removed you/),
    });
  });
});

describe("a rejoin reads the event's price under the checkout lock", () => {
  it("refuses with the left refusal when the host priced the event after the quote", async () => {
    // The quote reads the free plan; the host's edit commits before the commit's read.
    let reads = 0;
    overrides["webinar.findUnique"] = () => ({
      ...webinar,
      webinarPlan: {
        ...webinar.webinarPlan,
        price: reads++ === 0 ? 0 : 50_000,
      },
    });
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
    overrides["bookingStatusHistory.findMany"] = () => [
      { entityId: "part-1", reason: "self_leave" },
    ];
    const { error } = await run();
    expect(error).toMatchObject({
      httpStatus: 409,
      code: "SEAT_REBUY_UNSUPPORTED",
      message: expect.stringMatching(/left this event/),
    });
  });
});
