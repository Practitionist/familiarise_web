/**
 * @jest-environment node
 */

/**
 * Refund discovery pass: which listed refunds reach the refund webhook's
 * handler, what the pass itself writes (nothing), and how its position moves.
 * The handler is mocked here; the rows it writes are the database tier's.
 */

const mockReadCheckpoint = jest.fn();
jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: (...a: unknown[]) => mockReadCheckpoint(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    refund: { findMany: jest.fn(), findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
  },
}));

const mockList = jest.fn();
const mockFetchPayment = jest.fn();
let mockHasClient = true;
jest.mock("../../lib/payments/core/razorpay", () => ({
  listRazorpayRefundsCreatedBetween: (...a: unknown[]) => mockList(...a),
  getRazorpayClient: () =>
    mockHasClient
      ? { payments: { fetch: (...a: unknown[]) => mockFetchPayment(...a) } }
      : null,
  withRazorpaySdkTimeout: (_op: string, call: () => Promise<unknown>) => call(),
}));

class MockDeferSignal {
  constructor(readonly reason: string) {}
}
const mockHandleRefundCreated = jest.fn();
jest.mock("../../app/api/webhooks/utils", () => ({
  DeferSignal: MockDeferSignal,
  handleRefundCreated: (...a: unknown[]) => mockHandleRefundCreated(...a),
}));

const mockStanding = jest.fn();
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: async (args: unknown, report?: () => void) => {
    mockStanding(args);
    report?.();
    return true;
  },
}));
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryMessage: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { discoverGatewayRefunds } from "../../lib/payments/discovery/refund-discovery";

interface DiscoveryPrismaMock {
  refund: { findMany: jest.Mock; findUnique: jest.Mock };
  payment: { findMany: jest.Mock };
}
const db = prisma as unknown as DiscoveryPrismaMock;

const NOW = new Date("2026-11-27T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 24 * 60 * 60;
const HOUR_S = 60 * 60;
const never = () => false;
const minutesLater = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60_000);

/** A row holds the listed capture id, so the hand-over needs no gateway read. */
const paymentHeld = () =>
  db.payment.findMany.mockResolvedValue([
    { gatewayPaymentId: "pay_cap1", paymentIntent: "order_1" },
  ]);
const noPaymentHeld = () => db.payment.findMany.mockResolvedValue([]);
const deferral = () => new MockDeferSignal("refund-before-capture");

const listed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  payment_id: "pay_cap1",
  amount: 20_000,
  currency: "INR",
  status: "processed",
  notes: {},
  created_at: NOW_S - 600,
  ...over,
});

const fullPage = (prefix: string) =>
  Array.from({ length: 100 }, (_, i) => listed(`${prefix}_${i}`));

/** Every listed refund is already a row. */
const allKnown = () =>
  db.refund.findMany.mockImplementation(
    async (args: { where: { refundId: { in: string[] } } }) =>
      args.where.refundId.in.map((refundId) => ({ refundId })),
  );

const storedState = (state: object) =>
  mockReadCheckpoint.mockResolvedValue(JSON.stringify(state));

const positionOf = (run: { checkpoint?: string }) =>
  JSON.parse(run.checkpoint ?? "null") as {
    since: number | null;
    window: { from: number; to: number; skip: number } | null;
    cutRuns: number;
    deferred: { id: string; createdAt: number; triedAt: number }[];
  };

beforeEach(() => {
  jest.clearAllMocks();
  mockHasClient = true;
  mockReadCheckpoint.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
  db.refund.findMany.mockResolvedValue([]);
  db.refund.findUnique.mockResolvedValue({ id: "row_1" });
  paymentHeld();
  mockHandleRefundCreated.mockResolvedValue(undefined);
});

describe("what reaches the refund webhook's handler", () => {
  it("hands a refund the database does not hold to handleRefundCreated as its webhook would, and leaves a known one alone", async () => {
    mockList.mockResolvedValue([
      listed("rfnd_new", { notes: { reservationId: "res_1" } }),
      listed("rfnd_known"),
    ]);
    db.refund.findMany.mockResolvedValue([{ refundId: "rfnd_known" }]);

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(1);
    expect(mockHandleRefundCreated).toHaveBeenCalledWith(
      "rfnd_new",
      "order_1",
      20_000,
      "INR",
      "processed",
      "pay_cap1",
      { reservationId: "res_1" },
      undefined,
    );
    expect(mockFetchPayment).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      listed: 2,
      imported: 1,
      alreadyKnown: 1,
      unknownPayment: 0,
      stoppedShort: null,
      errors: [],
    });
  });

  it("reads the gateway payment when no row holds its id, and passes on its order and whether it was captured", async () => {
    mockList.mockResolvedValue([listed("rfnd_new", { payment_id: "pay_x" })]);
    noPaymentHeld();
    mockFetchPayment.mockResolvedValue({
      id: "pay_x",
      order_id: "order_x",
      captured: false,
    });

    await discoverGatewayRefunds(never, NOW);

    expect(mockFetchPayment).toHaveBeenCalledWith("pay_x");
    expect(mockHandleRefundCreated).toHaveBeenCalledWith(
      "rfnd_new",
      "order_x",
      20_000,
      "INR",
      "processed",
      "pay_x",
      {},
      false,
    );
  });

  it("never hands over a refund the gateway lists as failed", async () => {
    mockList.mockResolvedValue([listed("rfnd_failed", { status: "failed" })]);

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockHandleRefundCreated).not.toHaveBeenCalled();
    expect(run).toMatchObject({ listed: 1, gatewayFailed: 1, imported: 0 });
  });

  it("reports a refund whose payment the database does not know once, with its id, and still moves on", async () => {
    mockList.mockResolvedValue([listed("rfnd_orphan")]);
    mockHandleRefundCreated.mockResolvedValue(
      new MockDeferSignal("refund-before-capture"),
    );

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run).toMatchObject({ unknownPayment: 1, imported: 0, errors: [] });
    expect(mockStanding).toHaveBeenCalledTimes(1);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:discovery-unknown-payment",
        ids: ["rfnd_orphan"],
      }),
    );
    expect(db.refund.findUnique).not.toHaveBeenCalled();
    expect(positionOf(run)).toMatchObject({
      since: NOW_S,
      window: null,
      cutRuns: 0,
    });
  });

  it("counts a refund the handler booked without a Refund row apart from an import", async () => {
    mockList.mockResolvedValue([listed("rfnd_topup")]);
    db.refund.findUnique.mockResolvedValue(null);

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run).toMatchObject({ imported: 0, noRefundRow: 1 });
  });
});

describe("a refund the handler defers", () => {
  const CREATED = NOW_S - 3 * DAY_S;
  const early = (over: Record<string, unknown> = {}) =>
    listed("rfnd_early", { created_at: CREATED, ...over });
  const resume = (run: { checkpoint?: string }) =>
    mockReadCheckpoint.mockResolvedValue(run.checkpoint);

  it("keeps the next window open back to its creation and is imported once its payment is recorded", async () => {
    mockList.mockResolvedValue([early()]);
    mockHandleRefundCreated.mockResolvedValue(deferral());

    const first = await discoverGatewayRefunds(never, NOW);

    expect(first).toMatchObject({ unknownPayment: 1, imported: 0 });
    expect(positionOf(first)).toEqual({
      since: NOW_S,
      window: null,
      cutRuns: 0,
      deferred: [{ id: "rfnd_early", createdAt: CREATED, triedAt: NOW_S }],
    });

    // The capture is recorded; the next run's window still reaches the refund.
    mockHandleRefundCreated.mockResolvedValue(undefined);
    resume(first);
    const second = await discoverGatewayRefunds(never, minutesLater(15));

    expect(mockList).toHaveBeenLastCalledWith(
      { from: CREATED - 1, to: NOW_S + 900 },
      100,
      0,
    );
    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ imported: 1, unknownPayment: 0 });
    expect(positionOf(second).deferred).toEqual([]);

    resume(second);
    await discoverGatewayRefunds(never, minutesLater(30));

    expect(mockList).toHaveBeenLastCalledWith(
      { from: NOW_S + 900 - DAY_S, to: NOW_S + 1800 },
      100,
      0,
    );
  });

  it("holds the window without a gateway read on every run when no row holds its capture id: the next try is six hours later", async () => {
    noPaymentHeld();
    mockFetchPayment.mockResolvedValue({ id: "pay_cap1", order_id: "order_x" });
    mockList.mockResolvedValue([early()]);
    mockHandleRefundCreated.mockResolvedValue(deferral());

    const first = await discoverGatewayRefunds(never, NOW);
    resume(first);
    const soon = await discoverGatewayRefunds(never, minutesLater(15));

    expect(mockFetchPayment).toHaveBeenCalledTimes(1);
    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(1);
    expect(soon).toMatchObject({ waiting: 1, unknownPayment: 0 });
    expect(positionOf(soon).deferred).toEqual([
      { id: "rfnd_early", createdAt: CREATED, triedAt: NOW_S },
    ]);
    expect(mockStanding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:discovery-unknown-payment",
        ids: ["rfnd_early"],
      }),
    );

    resume(soon);
    await discoverGatewayRefunds(never, minutesLater(6 * 60));

    expect(mockFetchPayment).toHaveBeenCalledTimes(2);
    expect(mockList).toHaveBeenLastCalledWith(
      { from: CREATED - 1, to: NOW_S + 6 * HOUR_S },
      100,
      0,
    );
  });

  it("stops starting gateway-read hand-overs once five were deferred in a run, and remembers the rest as due", async () => {
    noPaymentHeld();
    mockFetchPayment.mockResolvedValue({ id: "pay_cap1", order_id: "order_x" });
    mockList.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => listed(`rfnd_orphan_${i}`)),
    );
    mockHandleRefundCreated.mockResolvedValue(deferral());

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockFetchPayment).toHaveBeenCalledTimes(5);
    expect(run).toMatchObject({ unknownPayment: 5, waiting: 1, notHeld: 0 });
    expect(positionOf(run).deferred).toHaveLength(6);
    expect(positionOf(run).since).toBe(NOW_S);
  });

  it("does not count a gateway-read hand-over the handler took against the run's five", async () => {
    noPaymentHeld();
    mockFetchPayment.mockResolvedValue({ id: "pay_cap1", order_id: "order_x" });
    mockList.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) => listed(`rfnd_topup_${i}`)),
      listed("rfnd_orphan"),
    ]);
    db.refund.findUnique.mockResolvedValue(null);
    mockHandleRefundCreated.mockImplementation(async (id: string) =>
      id === "rfnd_orphan" ? deferral() : undefined,
    );

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(6);
    expect(run).toMatchObject({
      noRefundRow: 5,
      unknownPayment: 1,
      waiting: 0,
    });
  });

  it("stops holding the window seven days after the gateway created it, and is reported once as no longer retried", async () => {
    const created = NOW_S - 7 * DAY_S + 600;
    storedState({
      since: NOW_S - 900,
      window: null,
      cutRuns: 0,
      deferred: [{ id: "rfnd_old", createdAt: created, triedAt: NOW_S - 900 }],
    });
    mockList.mockResolvedValue([listed("rfnd_old", { created_at: created })]);
    mockHandleRefundCreated.mockResolvedValue(deferral());

    const run = await discoverGatewayRefunds(never, minutesLater(15));

    expect(mockList).toHaveBeenCalledWith(
      { from: created - 1, to: NOW_S + 900 },
      100,
      0,
    );
    expect(run).toMatchObject({ unknownPayment: 1, notHeld: 1 });
    expect(positionOf(run)).toEqual({
      since: NOW_S + 900,
      window: null,
      cutRuns: 0,
      deferred: [],
    });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:discovery-not-held",
        ids: ["rfnd_old"],
      }),
    );
  });

  it("is not held, and is reported, when a hundred deferrals are already remembered", async () => {
    storedState({
      since: NOW_S - 900,
      window: null,
      cutRuns: 0,
      deferred: Array.from({ length: 100 }, (_, i) => ({
        id: `rfnd_held_${i}`,
        createdAt: NOW_S - 1200,
        triedAt: NOW_S - 900,
      })),
    });
    mockList.mockResolvedValue([listed("rfnd_extra")]);
    mockHandleRefundCreated.mockResolvedValue(deferral());

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run).toMatchObject({ unknownPayment: 1, notHeld: 1 });
    expect(positionOf(run).deferred).toHaveLength(100);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:discovery-not-held",
        ids: ["rfnd_extra"],
      }),
    );
  });

  it("is forgotten when the list later shows it failed or a row already holds it", async () => {
    storedState({
      since: NOW_S - 900,
      window: null,
      cutRuns: 0,
      deferred: [
        { id: "rfnd_failed", createdAt: NOW_S - 1200, triedAt: NOW_S - 900 },
        { id: "rfnd_known", createdAt: NOW_S - 1200, triedAt: NOW_S - 900 },
      ],
    });
    mockList.mockResolvedValue([
      listed("rfnd_failed", { status: "failed" }),
      listed("rfnd_known"),
    ]);
    db.refund.findMany.mockResolvedValue([{ refundId: "rfnd_known" }]);

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockHandleRefundCreated).not.toHaveBeenCalled();
    expect(positionOf(run).deferred).toEqual([]);
  });
});

describe("the window and its position", () => {
  it("looks back seven days on the first run and moves the position to the window's end", async () => {
    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockReadCheckpoint).toHaveBeenCalledWith(
      "reconcile-pending-refunds",
    );
    expect(mockList).toHaveBeenCalledWith(
      { from: NOW_S - 7 * DAY_S, to: NOW_S },
      100,
      0,
    );
    expect(positionOf(run)).toEqual({
      since: NOW_S,
      window: null,
      cutRuns: 0,
      deferred: [],
    });
  });

  it("re-reads the day behind the stored position", async () => {
    storedState({ since: NOW_S - 900, window: null, cutRuns: 0 });

    await discoverGatewayRefunds(never, NOW);

    expect(mockList).toHaveBeenCalledWith(
      { from: NOW_S - 900 - DAY_S, to: NOW_S },
      100,
      0,
    );
  });

  it("stops at the page bound, names it, and resumes the same window after the pages it handled", async () => {
    allKnown();
    mockList.mockImplementation(async (_w: unknown, _c: number, skip: number) =>
      fullPage(`rfnd_${skip}`),
    );

    const first = await discoverGatewayRefunds(never, NOW);

    expect(mockList).toHaveBeenCalledTimes(3);
    expect(first.stoppedShort).toEqual({ bound: "pages", pagesHandled: 3 });
    expect(positionOf(first)).toEqual({
      since: null,
      window: { from: NOW_S - 7 * DAY_S, to: NOW_S, skip: 300 },
      cutRuns: 1,
      deferred: [],
    });

    mockList.mockClear();
    mockList.mockResolvedValue([listed("rfnd_last")]);
    mockReadCheckpoint.mockResolvedValue(first.checkpoint);
    const later = new Date(NOW.getTime() + 15 * 60_000);
    const second = await discoverGatewayRefunds(never, later);

    expect(mockList).toHaveBeenCalledWith(
      { from: NOW_S - 7 * DAY_S, to: NOW_S },
      100,
      300,
    );
    expect(second.stoppedShort).toBeNull();
    expect(positionOf(second)).toEqual({
      since: NOW_S,
      window: null,
      cutRuns: 0,
      deferred: [],
    });
  });

  it("stops at the run deadline inside a page without moving past that page", async () => {
    mockList.mockResolvedValue([listed("rfnd_a"), listed("rfnd_b")]);
    let handed = 0;
    mockHandleRefundCreated.mockImplementation(async () => {
      handed++;
    });

    const run = await discoverGatewayRefunds(() => handed >= 1, NOW);

    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(1);
    expect(run.stoppedShort).toEqual({ bound: "deadline", pagesHandled: 0 });
    expect(positionOf(run)).toEqual({
      since: null,
      window: { from: NOW_S - 7 * DAY_S, to: NOW_S, skip: 0 },
      cutRuns: 1,
      deferred: [],
    });
  });

  it("keeps the page for the next run when a hand-over fails, and still hands over the rest of it", async () => {
    mockList.mockResolvedValue([listed("rfnd_bad"), listed("rfnd_good")]);
    mockHandleRefundCreated
      .mockRejectedValueOnce(new Error("could not serialize access"))
      .mockResolvedValueOnce(undefined);

    const run = await discoverGatewayRefunds(never, NOW);

    expect(mockHandleRefundCreated).toHaveBeenCalledTimes(2);
    expect(run.errors).toEqual(["Refund rfnd_bad: could not serialize access"]);
    expect(run).toMatchObject({ imported: 1, stoppedShort: null });
    expect(positionOf(run)).toEqual({
      since: null,
      window: { from: NOW_S - 7 * DAY_S, to: NOW_S, skip: 0 },
      cutRuns: 0,
      deferred: [],
    });
  });

  it("keeps the position it reached when a database read fails on a later page", async () => {
    mockList.mockImplementation(async (_w: unknown, _c: number, skip: number) =>
      fullPage(`rfnd_${skip}`),
    );
    db.refund.findMany
      .mockImplementationOnce(
        async (args: { where: { refundId: { in: string[] } } }) =>
          args.where.refundId.in.map((refundId) => ({ refundId })),
      )
      .mockRejectedValueOnce(new Error("connection terminated"));

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run.errors).toEqual(["Refund lookup: connection terminated"]);
    expect(run).toMatchObject({ listed: 200, alreadyKnown: 100 });
    expect(positionOf(run)).toEqual({
      since: null,
      window: { from: NOW_S - 7 * DAY_S, to: NOW_S, skip: 100 },
      cutRuns: 0,
      deferred: [],
    });
  });

  it("still returns its position when a finding cannot be recorded", async () => {
    mockList.mockResolvedValue([listed("rfnd_orphan")]);
    mockHandleRefundCreated.mockResolvedValue(deferral());
    mockStanding.mockImplementationOnce(() => {
      throw new Error("system event insert failed");
    });

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run.errors).toEqual([
      "Refund discovery findings: system event insert failed",
    ]);
    expect(positionOf(run)).toMatchObject({ since: NOW_S, window: null });
  });

  it("keeps its position when the list call fails", async () => {
    storedState({ since: NOW_S - 900, window: null, cutRuns: 0 });
    mockList.mockRejectedValue(new Error("Razorpay SDK refunds.all timed out"));

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run.errors).toEqual([
      "Refund list: Razorpay SDK refunds.all timed out",
    ]);
    expect(positionOf(run)).toEqual({
      since: NOW_S - 900,
      window: { from: NOW_S - 900 - DAY_S, to: NOW_S, skip: 0 },
      cutRuns: 0,
      deferred: [],
    });
  });

  it("raises the standing finding when a bound cuts the pass on a second run in a row", async () => {
    allKnown();
    mockList.mockImplementation(async (_w: unknown, _c: number, skip: number) =>
      fullPage(`rfnd_${skip}`),
    );
    storedState({
      since: null,
      window: { from: NOW_S - 7 * DAY_S, to: NOW_S, skip: 300 },
      cutRuns: 1,
    });

    const run = await discoverGatewayRefunds(never, NOW);

    expect(positionOf(run).cutRuns).toBe(2);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-pending-refunds:discovery-cut",
        ids: ["pages"],
      }),
    );
  });

  it("does nothing and keeps the stored position when the gateway keys are absent", async () => {
    mockHasClient = false;

    const run = await discoverGatewayRefunds(never, NOW);

    expect(run.skipped).toBe(
      "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
    );
    expect(run.checkpoint).toBeUndefined();
    expect(mockList).not.toHaveBeenCalled();
  });
});
