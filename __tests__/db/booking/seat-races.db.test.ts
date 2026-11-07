/**
 * Seat checkouts on one webinar under load and against a whole-event cancel.
 * The seat commits under the event's checkout key and its gateway order is
 * minted after the key is released, so:
 *  - a herd of buyers never oversells, and sells out fast even with a slow
 *    gateway (the mint is outside the mutex);
 *  - a whole-event cancel and a seat checkout serialise on the event key, so no
 *    seat is left held on a cancelled event.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { gate } from "./harness";
import {
  liveSeatCount,
  seatCheckoutInput,
  seedSeatBuyer,
  seedWebinar,
  type SeededWebinar,
} from "./harness-seats";

/** The mock gateway: a fixed delay, and how many mints were in flight at once. */
const gateway = {
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** The id the next mint returns, when a test needs to know it. */
  nextOrderId: null as string | null,
};
jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => {
    gateway.inFlight += 1;
    gateway.maxInFlight = Math.max(gateway.maxInFlight, gateway.inFlight);
    await new Promise((resolve) => setTimeout(resolve, gateway.delayMs));
    gateway.inFlight -= 1;
    const id = gateway.nextOrderId ?? `order_${randomUUID()}`;
    gateway.nextOrderId = null;
    return { id, client_secret: null };
  }),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
// Every gateway order cancel is recorded, then runs as it would.
const gatewayCancels = jest.fn();
jest.mock("../../../lib/booking/pending-payment-expiry", () => {
  const actual = jest.requireActual(
    "../../../lib/booking/pending-payment-expiry",
  );
  return {
    ...actual,
    cancelGatewayOrders: async (...args: unknown[]) => {
      gatewayCancels(...args);
      return actual.cancelGatewayOrders(...args);
    },
  };
});
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
// Every bell is a no-op: notifications are outside the race under test.
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(async () => undefined),
  persistSeatRevocation: jest.fn(async () => undefined),
}));
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
/** Parks a whole-event cancel inside its transaction, event key held. */
const cancelGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/payments/operations/event-refunds", () => {
  const actual = jest.requireActual(
    "../../../lib/payments/operations/event-refunds",
  );
  return {
    ...actual,
    stampWholeEventRefundsOwed: async (...args: unknown[]) => {
      const g = cancelGate.current;
      if (g) {
        cancelGate.current = null;
        await g.park();
      }
      return actual.stampWholeEventRefundsOwed(...args);
    },
  };
});

import { handleCheckout } from "../../../lib/payments/checkout";
import { isPoolExhaustion } from "../../../lib/db/pg-errors";
import {
  classifyError as classifyCheckoutError,
  ErrorTypes,
} from "../../../lib/errors/classification/payment-error-classification";
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";

beforeEach(() => {
  gateway.delayMs = 0;
  gateway.inFlight = 0;
  gateway.maxInFlight = 0;
  gateway.nextOrderId = null;
});

type Outcome =
  | { kind: "sold" }
  | { kind: "refused"; code: string }
  | { kind: "busy" }
  | { kind: "unexpected"; error: unknown };

const SOLD_OUT = new Set(["EVENT_SOLD_OUT", "EVENT_FULL"]);
const BUSY = new Set([
  "EVENT_CHECKOUT_BUSY",
  "CONSULTEE_BOOKING_BUSY",
  "SERIALIZATION_CONFLICT",
]);

function classify(error: unknown): Outcome {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SOLD_OUT.has(code))
    return { kind: "refused", code };
  if (typeof code === "string" && BUSY.has(code)) return { kind: "busy" };
  if (error instanceof Error && /currently booking/i.test(error.message))
    return { kind: "busy" };
  // All fifty buyers share this jest process's one 10-connection pool; on a
  // loaded machine a transaction can wait past its maxWait before it starts.
  // Nothing was written, so the buyer retries it like any busy answer.
  if (isPoolExhaustion(error)) return { kind: "busy" };
  return { kind: "unexpected", error };
}

/** When each herd buyer's seat committed and its order came back. */
const soldAt: number[] = [];

/** One buyer as the client behaves: retry a busy answer with jitter until the budget ends. */
async function buyAsClient(
  webinar: SeededWebinar,
  userId: string,
  deadline: number,
): Promise<Outcome> {
  const key = `herd-${randomUUID()}`;
  for (;;) {
    try {
      await handleCheckout(seatCheckoutInput(webinar, key), userId);
      soldAt.push(Date.now());
      return { kind: "sold" };
    } catch (error) {
      const outcome = classify(error);
      if (outcome.kind !== "busy" || Date.now() > deadline) return outcome;
      await new Promise((resolve) =>
        setTimeout(resolve, 100 + Math.random() * 300),
      );
    }
  }
}

describe("seat checkout", () => {
  it("sells one seat: a HELD seat and a PENDING payment carrying the minted order", async () => {
    const webinar = await seedWebinar({ capacity: 5 });
    const buyer = await seedSeatBuyer();

    const res = await handleCheckout(
      seatCheckoutInput(webinar, `seat-${randomUUID()}`),
      buyer.userId,
    );

    expect(res).toMatchObject({ success: true });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: buyer.userId, appointmentId: webinar.appointmentId },
    });
    expect(payment.paymentStatus).toBe("PENDING");
    expect(payment.paymentIntent).toMatch(/^order_/);
    expect(await liveSeatCount(webinar.appointmentId)).toBe(1);
  });

  it("a 50-buyer herd on 20 seats with an 800 ms gateway sells exactly 20, mints outside the mutex, never a fault", async () => {
    const webinar = await seedWebinar({ capacity: 20 });
    const buyers = await Promise.all(
      Array.from({ length: 50 }, () => seedSeatBuyer()),
    );
    gateway.delayMs = 800;
    // Fifty buyers' structured lock logs would drown the run's own output.
    const quiet = jest
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    soldAt.length = 0;
    const started = Date.now();
    const outcomes = await Promise.all(
      // A busy buyer keeps retrying until it hears sold out; the deadline only
      // bounds a starved machine, and a buyer still busy then is a typed BUSY.
      buyers.map((b) => buyAsClient(webinar, b.userId, started + 150_000)),
    );
    const elapsedToSellOut = Math.max(...soldAt) - started;
    quiet.mockRestore();

    const tally = (kind: Outcome["kind"]) =>
      outcomes.filter((o) => o.kind === kind).length;
    // Correctness only: exactly capacity sold, every loser a typed refusal.
    expect(outcomes.filter((o) => o.kind === "unexpected")).toEqual([]);
    expect(tally("sold")).toBe(20);
    expect(tally("refused") + tally("busy")).toBe(30);
    // Every loser hears sold out before the deadline: a buyer still busy at
    // 150 s means a key outlived the sell-out.
    expect(tally("busy")).toBe(0);
    // Zero oversell, and no seat held without a live payment behind it.
    expect(await liveSeatCount(webinar.appointmentId)).toBe(20);
    expect(await heldOrConfirmedSeats(webinar.appointmentId)).toBe(20);
    // The mint runs after the event key is released, so mints overlap.
    expect(gateway.maxInFlight).toBeGreaterThan(1);
    // Throughput is a measurement, not a gate: it depends on the machine.
    console.info(
      `[seat herd] sold out in ${elapsedToSellOut} ms; ${tally("busy")} buyer(s) still busy at the deadline`,
    );
  }, 240_000);
});

/** Seats a consultee occupies on the event, live payment or not. */
async function heldOrConfirmedSeats(appointmentId: string): Promise<number> {
  return prisma.appointmentParticipant.count({
    where: {
      appointmentId,
      role: "CONSULTEE",
      status: { in: ["HELD", "CONFIRMED"] },
    },
  });
}

describe("whole-event cancel × seat checkout", () => {
  async function seedHostCancel() {
    const webinar = await seedWebinar({ capacity: 10 });
    sessionUser.current = {
      id: webinar.host.userId,
      role: "CONSULTANT",
      consultantProfileId: webinar.host.consultantProfileId,
      consulteeProfileId: null,
      name: "Host",
    };
    return webinar;
  }
  const cancelEvent = (appointmentId: string) =>
    cancel(
      new NextRequest(
        `http://localhost/api/appointments/${appointmentId}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "SCHEDULE_CONFLICT" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ appointmentId }) },
    );

  it("a checkout racing a cancel that holds the event key is refused busy; no seat lands on the cancelled event", async () => {
    const webinar = await seedHostCancel();
    const buyer = await seedSeatBuyer();
    const paused = gate();
    cancelGate.current = paused;

    const cancelling = cancelEvent(webinar.appointmentId);
    await paused.arrived;
    const checkout = await handleCheckout(
      seatCheckoutInput(webinar, `seat-${randomUUID()}`),
      buyer.userId,
    ).then(
      () => ({ kind: "sold" }) as Outcome,
      (error: unknown) => classify(error),
    );
    paused.open();
    const res = await cancelling;

    expect(res.status).toBe(200);
    expect(checkout).toEqual({ kind: "busy" });
    const webinarRow = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinar.webinarId },
    });
    expect(webinarRow.status).toBe("CANCELLED");
    expect(await liveSeatCount(webinar.appointmentId)).toBe(0);
  });

  it("a seat committed before the cancel is released by it", async () => {
    const webinar = await seedHostCancel();
    const buyer = await seedSeatBuyer();

    await handleCheckout(
      seatCheckoutInput(webinar, `seat-${randomUUID()}`),
      buyer.userId,
    );
    expect(await liveSeatCount(webinar.appointmentId)).toBe(1);
    const res = await cancelEvent(webinar.appointmentId);

    expect(res.status).toBe(200);
    expect(await liveSeatCount(webinar.appointmentId)).toBe(0);
  });

  it("a checkout after the cancel commits is refused, never seated", async () => {
    const webinar = await seedHostCancel();
    const buyer = await seedSeatBuyer();

    expect((await cancelEvent(webinar.appointmentId)).status).toBe(200);
    const outcome: unknown = await handleCheckout(
      seatCheckoutInput(webinar, `seat-${randomUUID()}`),
      buyer.userId,
    ).then(
      () => "sold",
      (error: unknown) => error,
    );

    // A typed business refusal the route answers 4xx, never a fault.
    expect(outcome).toBeInstanceOf(Error);
    const classified = classifyCheckoutError(outcome);
    expect(classified).toMatchObject({
      isBusinessError: true,
      errorType: ErrorTypes.EVENT_EXPIRED,
    });
    const { httpStatus } = classified;
    expect(httpStatus).toBeGreaterThanOrEqual(400);
    expect(httpStatus).toBeLessThan(500);
    expect(await liveSeatCount(webinar.appointmentId)).toBe(0);
    expect(
      await prisma.payment.count({
        where: { userId: buyer.userId, paymentStatus: "PENDING" },
      }),
    ).toBe(0);
  });
});

describe("a seat whose order fill throws", () => {
  // Makes the post-mint fill transaction fail on the CARD leg's update, the way
  // a pool timeout or a dropped connection would, for one marked order id.
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION db_tier_fail_fill() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceRef" LIKE 'order_fillfail_%' THEN
          RAISE EXCEPTION 'fill failed for the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER db_tier_fail_fill BEFORE UPDATE ON "PaymentLeg"
      FOR EACH ROW EXECUTE FUNCTION db_tier_fail_fill()`);
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS db_tier_fail_fill ON "PaymentLeg"`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS db_tier_fail_fill`);
  });

  it("cancels the fresh order and releases the seat instead of holding it", async () => {
    const webinar = await seedWebinar({ capacity: 5 });
    const buyer = await seedSeatBuyer();
    const orderId = `order_fillfail_${randomUUID()}`;
    gateway.nextOrderId = orderId;
    gatewayCancels.mockClear();

    await expect(
      handleCheckout(
        seatCheckoutInput(webinar, `seat-${randomUUID()}`),
        buyer.userId,
      ),
    ).rejects.toBeDefined();

    expect(gatewayCancels).toHaveBeenCalledWith(
      [{ paymentIntent: orderId, gateway: "RAZORPAY" }],
      expect.anything(),
    );
    expect(await liveSeatCount(webinar.appointmentId)).toBe(0);
    expect(
      await prisma.payment.count({
        where: { userId: buyer.userId, paymentStatus: "PENDING" },
      }),
    ).toBe(0);
  });
});
