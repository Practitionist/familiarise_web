/**
 * @jest-environment node
 */

/**
 * Dispute discovery pass: which listed disputes reach the dispute webhook's
 * handlers and in what order, what the pass writes itself (nothing), and how
 * its place in the list moves. The handlers are mocked here.
 */

const mockReadCheckpoint = jest.fn();
jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: (...a: unknown[]) => mockReadCheckpoint(...a),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: { findMany: jest.fn(), findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
  },
}));

const mockList = jest.fn();
jest.mock("../../lib/payments/core/razorpay-disputes", () => ({
  listRazorpayDisputes: (...a: unknown[]) => mockList(...a),
}));
let mockHasClient = true;
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => (mockHasClient ? {} : null),
}));

class MockDeferSignal {
  constructor(readonly reason: string) {}
}
const mockCalls: string[] = [];
const mockHandleDisputeCreated = jest.fn();
const mockHandleDisputeUpdated = jest.fn();
jest.mock("../../app/api/webhooks/utils", () => ({
  DeferSignal: MockDeferSignal,
  handleDisputeCreated: (...a: unknown[]) => {
    mockCalls.push("created");
    return mockHandleDisputeCreated(...a);
  },
  handleDisputeUpdated: (...a: unknown[]) => {
    mockCalls.push("updated");
    return mockHandleDisputeUpdated(...a);
  },
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
import { discoverGatewayDisputes } from "../../lib/payments/discovery/dispute-discovery";

interface DiscoveryPrismaMock {
  dispute: { findMany: jest.Mock; findUnique: jest.Mock };
  payment: { findMany: jest.Mock };
}
const db = prisma as unknown as DiscoveryPrismaMock;

const never = () => false;
const NOW = new Date("2026-11-27T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const HOUR_S = 60 * 60;
const hoursLater = (hours: number) =>
  new Date(NOW.getTime() + hours * HOUR_S * 1000);

/** Every listed payment id is the capture id of a payment row, so no hand-over needs a gateway read. */
const allPaymentsHeld = () =>
  db.payment.findMany.mockImplementation(
    async (args: { where: { gatewayPaymentId: { in: string[] } } }) =>
      args.where.gatewayPaymentId.in.map((gatewayPaymentId) => ({
        gatewayPaymentId,
      })),
  );

const deferral = (id: string) =>
  new MockDeferSignal(`dispute_before_payment:${id}`);

const listed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  payment_id: "pay_cap1",
  amount: 50_000,
  currency: "INR",
  status: "open",
  phase: "chargeback",
  reason_code: "goods_not_received",
  respond_by: 1_800_000_000,
  amount_deducted: 0,
  ...over,
});

const fullPage = (prefix: string) =>
  Array.from({ length: 100 }, (_, i) => listed(`${prefix}_${i}`));

/** The rows the database holds, by gateway dispute id. */
const held = (rows: Record<string, string>) =>
  db.dispute.findMany.mockImplementation(
    async (args: { where: { disputeId: { in: string[] } } }) =>
      args.where.disputeId.in
        .filter((id) => id in rows)
        .map((disputeId) => ({ disputeId, status: rows[disputeId] })),
  );

/** Every listed dispute is a row in the status the gateway lists. */
const allKnownOpen = () =>
  db.dispute.findMany.mockImplementation(
    async (args: { where: { disputeId: { in: string[] } } }) =>
      args.where.disputeId.in.map((disputeId) => ({
        disputeId,
        status: "NEEDS_RESPONSE",
      })),
  );

const positionOf = (run: { checkpoint?: string }) =>
  JSON.parse(run.checkpoint ?? "null") as {
    skip: number;
    cutRuns: number;
    deferred: { id: string; triedAt: number }[];
  };

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockHasClient = true;
  mockReadCheckpoint.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
  db.dispute.findMany.mockResolvedValue([]);
  db.dispute.findUnique.mockResolvedValue(null);
  allPaymentsHeld();
  mockHandleDisputeCreated.mockResolvedValue(undefined);
  mockHandleDisputeUpdated.mockResolvedValue(undefined);
});

describe("a dispute the database does not hold", () => {
  it("goes through handleDisputeCreated as an open dispute, with no per-call alert", async () => {
    mockList.mockResolvedValue([
      listed("disp_new", { reason_description: "Goods not received" }),
    ]);

    const run = await discoverGatewayDisputes(never);

    expect(mockHandleDisputeCreated).toHaveBeenCalledWith(
      "disp_new",
      "pay_cap1",
      50_000,
      "INR",
      "Goods not received",
      "open",
      1_800_000_000,
      false,
      {
        isRedrive: true,
        phase: "chargeback",
        webhookEventId: "dispute-discovery:disp_new:open:chargeback",
      },
    );
    expect(mockHandleDisputeUpdated).not.toHaveBeenCalled();
    expect(run).toMatchObject({ listed: 1, imported: 1, errors: [] });
  });

  it("is created open and then moved to the status the gateway lists, so a decided dispute is settled and not born decided", async () => {
    mockList.mockResolvedValue([
      listed("disp_lost", { status: "lost", amount_deducted: 50_000 }),
    ]);

    const run = await discoverGatewayDisputes(never);

    expect(mockCalls).toEqual(["created", "updated"]);
    expect(mockHandleDisputeCreated.mock.calls[0][5]).toBe("open");
    expect(mockHandleDisputeUpdated).toHaveBeenCalledWith(
      "disp_lost",
      "lost",
      null,
      1_800_000_000,
      50_000,
      "chargeback",
      "dispute-discovery:disp_lost:lost:chargeback",
    );
    expect(run).toMatchObject({ imported: 1 });
  });

  it("is reported once with its id when no payment is found for it, and nothing follows", async () => {
    mockList.mockResolvedValue([listed("disp_orphan", { status: "lost" })]);
    mockHandleDisputeCreated.mockResolvedValue(
      new MockDeferSignal("dispute_before_payment:disp_orphan"),
    );

    const run = await discoverGatewayDisputes(never);

    expect(mockHandleDisputeUpdated).not.toHaveBeenCalled();
    expect(run).toMatchObject({ unknownPayment: 1, imported: 0, errors: [] });
    expect(mockStanding).toHaveBeenCalledTimes(1);
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-disputes:discovery-unknown-payment",
        ids: ["disp_orphan"],
      }),
    );
  });
});

describe("a dispute the database holds", () => {
  it("is left alone when its listed status is the stored one", async () => {
    mockList.mockResolvedValue([
      listed("disp_open"),
      listed("disp_won", { status: "won" }),
    ]);
    held({ disp_open: "NEEDS_RESPONSE", disp_won: "WON" });

    const run = await discoverGatewayDisputes(never);

    expect(mockCalls).toEqual([]);
    expect(run).toMatchObject({ listed: 2, alreadyKnown: 2 });
  });

  it("goes through handleDisputeUpdated when the listed status differs, carrying the deduction", async () => {
    mockList.mockResolvedValue([
      listed("disp_review", { status: "lost", amount_deducted: 30_000 }),
    ]);
    held({ disp_review: "UNDER_REVIEW" });
    db.dispute.findUnique.mockResolvedValue({ status: "LOST" });

    const run = await discoverGatewayDisputes(never);

    expect(mockHandleDisputeCreated).not.toHaveBeenCalled();
    expect(mockHandleDisputeUpdated).toHaveBeenCalledWith(
      "disp_review",
      "lost",
      null,
      1_800_000_000,
      30_000,
      "chargeback",
      "dispute-discovery:disp_review:lost:chargeback",
    );
    expect(run).toMatchObject({ updated: 1, notAdopted: 0 });
  });

  it("hands a won dispute listed in a later phase to handleDisputeUpdated under one stable event id, and counts it not adopted", async () => {
    mockList.mockResolvedValue([
      listed("disp_won", { status: "open", phase: "pre_arbitration" }),
    ]);
    held({ disp_won: "WON" });
    db.dispute.findUnique.mockResolvedValue({ status: "WON" });

    const first = await discoverGatewayDisputes(never);
    await discoverGatewayDisputes(never);

    expect(mockHandleDisputeUpdated).toHaveBeenCalledTimes(2);
    for (const call of mockHandleDisputeUpdated.mock.calls) {
      expect(call[6]).toBe("dispute-discovery:disp_won:open:pre_arbitration");
    }
    expect(first).toMatchObject({ updated: 0, notAdopted: 1 });
  });

  it("hands over a decided dispute whose status is unchanged but whose phase moved past the first round", async () => {
    mockList.mockResolvedValue([
      listed("disp_won", { status: "won", phase: "arbitration" }),
    ]);
    held({ disp_won: "WON" });
    db.dispute.findUnique.mockResolvedValue({ status: "WON" });

    await discoverGatewayDisputes(never);

    expect(mockHandleDisputeUpdated).toHaveBeenCalledTimes(1);
  });
});

describe("a dispute on a payment the database does not hold", () => {
  const unlinked = (id: string) => listed(id, { payment_id: `pay_of_${id}` });
  const noPaymentHeld = () => db.payment.findMany.mockResolvedValue([]);
  const resume = (run: { checkpoint?: string }) =>
    mockReadCheckpoint.mockResolvedValue(run.checkpoint);

  it("is remembered once deferred and passed over without a hand-over until six hours later", async () => {
    noPaymentHeld();
    mockList.mockResolvedValue([unlinked("disp_orphan")]);
    mockHandleDisputeCreated.mockResolvedValue(deferral("disp_orphan"));

    const first = await discoverGatewayDisputes(never, NOW);

    expect(first).toMatchObject({ unknownPayment: 1, waiting: 0 });
    expect(positionOf(first).deferred).toEqual([
      { id: "disp_orphan", triedAt: NOW_S },
    ]);

    resume(first);
    const soon = await discoverGatewayDisputes(never, hoursLater(1));

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(1);
    expect(soon).toMatchObject({ unknownPayment: 0, waiting: 1, untried: 0 });
    expect(mockStanding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: "reconcile-disputes:discovery-unknown-payment",
        ids: ["disp_orphan"],
      }),
    );

    resume(soon);
    const later = await discoverGatewayDisputes(never, hoursLater(6));

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(2);
    expect(positionOf(later).deferred).toEqual([
      { id: "disp_orphan", triedAt: NOW_S + 6 * HOUR_S },
    ]);
  });

  it("stops starting gateway-read hand-overs once five were deferred in a run, and still reaches the disputes behind them", async () => {
    const orphans = Array.from({ length: 7 }, (_, i) => `disp_orphan_${i}`);
    db.payment.findMany.mockResolvedValue([{ gatewayPaymentId: "pay_cap1" }]);
    mockList.mockResolvedValue([...orphans.map(unlinked), listed("disp_held")]);
    mockHandleDisputeCreated.mockImplementation(async (id: string) =>
      id === "disp_held" ? undefined : deferral(id),
    );

    const first = await discoverGatewayDisputes(never, NOW);

    expect(mockHandleDisputeCreated.mock.calls.map((c) => c[0])).toEqual([
      ...orphans.slice(0, 5),
      "disp_held",
    ]);
    expect(first).toMatchObject({
      imported: 1,
      unknownPayment: 5,
      waiting: 2,
      untried: 0,
      stoppedShort: null,
    });
    expect(positionOf(first)).toMatchObject({ skip: 0, cutRuns: 0 });
    expect(positionOf(first).deferred).toHaveLength(7);

    // The two left over are first in the next run; the five just tried wait.
    mockHandleDisputeCreated.mockClear();
    db.dispute.findMany.mockResolvedValue([
      { disputeId: "disp_held", status: "NEEDS_RESPONSE" },
    ]);
    resume(first);
    const second = await discoverGatewayDisputes(never, hoursLater(1));

    expect(mockHandleDisputeCreated.mock.calls.map((c) => c[0])).toEqual(
      orphans.slice(5),
    );
    expect(second).toMatchObject({ unknownPayment: 2, waiting: 5 });
  });

  it("does not count a gateway-read hand-over that imported its dispute against the run's five", async () => {
    noPaymentHeld();
    mockList.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) => unlinked(`disp_by_order_${i}`)),
      unlinked("disp_orphan"),
    ]);
    mockHandleDisputeCreated.mockImplementation(async (id: string) =>
      id === "disp_orphan" ? deferral(id) : undefined,
    );

    const run = await discoverGatewayDisputes(never, NOW);

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(6);
    expect(run).toMatchObject({ imported: 5, unknownPayment: 1, waiting: 0 });
  });

  it("is tried every run and not remembered while its payment row only awaits its capture", async () => {
    mockList.mockResolvedValue([listed("disp_pending")]);
    mockHandleDisputeCreated.mockResolvedValue(deferral("disp_pending"));

    const first = await discoverGatewayDisputes(never, NOW);
    resume(first);
    await discoverGatewayDisputes(never, hoursLater(1));

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(2);
    expect(positionOf(first).deferred).toEqual([]);
    expect(first).toMatchObject({ unknownPayment: 1 });
  });

  it("is passed over untried and reported when a hundred deferrals are already remembered", async () => {
    noPaymentHeld();
    mockReadCheckpoint.mockResolvedValue(
      JSON.stringify({
        skip: 0,
        cutRuns: 0,
        deferred: Array.from({ length: 100 }, (_, i) => ({
          id: `disp_old_${i}`,
          triedAt: NOW_S,
        })),
      }),
    );
    mockList.mockResolvedValue([unlinked("disp_extra")]);

    const run = await discoverGatewayDisputes(never, hoursLater(1));

    expect(mockHandleDisputeCreated).not.toHaveBeenCalled();
    expect(run).toMatchObject({ untried: 1, unknownPayment: 0 });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-disputes:discovery-untried",
        ids: ["disp_extra"],
      }),
    );
    expect(positionOf(run).deferred).toHaveLength(100);
  });

  it("is forgotten once it has a row, or after seven days without a try", async () => {
    mockReadCheckpoint.mockResolvedValue(
      JSON.stringify({
        skip: 0,
        cutRuns: 0,
        deferred: [
          { id: "disp_now_known", triedAt: NOW_S },
          { id: "disp_gone", triedAt: NOW_S - 8 * 24 * HOUR_S },
          { id: "disp_elsewhere", triedAt: NOW_S - 24 * HOUR_S },
        ],
      }),
    );
    mockList.mockResolvedValue([listed("disp_now_known")]);
    held({ disp_now_known: "NEEDS_RESPONSE" });

    const run = await discoverGatewayDisputes(never, NOW);

    expect(positionOf(run).deferred).toEqual([
      { id: "disp_elsewhere", triedAt: NOW_S - 24 * HOUR_S },
    ]);
  });
});

describe("the place in the list", () => {
  it("starts at the top with no stored position and returns to it at the last page", async () => {
    const run = await discoverGatewayDisputes(never);

    expect(mockReadCheckpoint).toHaveBeenCalledWith("reconcile-disputes");
    expect(mockList).toHaveBeenCalledWith(100, 0);
    expect(positionOf(run)).toEqual({ skip: 0, cutRuns: 0, deferred: [] });
    expect(run.stoppedShort).toBeNull();
  });

  it("stops at the page bound, names it, and resumes after the pages it handled", async () => {
    allKnownOpen();
    mockList.mockImplementation(async (_count: number, skip: number) =>
      fullPage(`disp_${skip}`),
    );

    const first = await discoverGatewayDisputes(never);

    expect(mockList).toHaveBeenCalledTimes(3);
    expect(first.stoppedShort).toEqual({ bound: "pages", pagesHandled: 3 });
    expect(positionOf(first)).toEqual({ skip: 300, cutRuns: 1, deferred: [] });

    mockList.mockClear();
    mockList.mockResolvedValue([listed("disp_last")]);
    mockReadCheckpoint.mockResolvedValue(first.checkpoint);
    const second = await discoverGatewayDisputes(never);

    expect(mockList).toHaveBeenCalledWith(100, 300);
    expect(positionOf(second)).toEqual({ skip: 0, cutRuns: 0, deferred: [] });
  });

  it("stops at the run deadline inside a page without moving past that page", async () => {
    mockList.mockResolvedValue([listed("disp_a"), listed("disp_b")]);
    let handed = 0;
    mockHandleDisputeCreated.mockImplementation(async () => {
      handed++;
    });

    const run = await discoverGatewayDisputes(() => handed >= 1);

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(1);
    expect(run.stoppedShort).toEqual({ bound: "deadline", pagesHandled: 0 });
    expect(positionOf(run)).toEqual({ skip: 0, cutRuns: 1, deferred: [] });
  });

  it("keeps the page for the next run when a hand-over fails, and still hands over the rest of it", async () => {
    mockReadCheckpoint.mockResolvedValue(
      JSON.stringify({ skip: 100, cutRuns: 0 }),
    );
    mockList.mockResolvedValue([listed("disp_bad"), listed("disp_good")]);
    mockHandleDisputeCreated
      .mockRejectedValueOnce(new Error("could not serialize access"))
      .mockResolvedValueOnce(undefined);

    const run = await discoverGatewayDisputes(never);

    expect(mockHandleDisputeCreated).toHaveBeenCalledTimes(2);
    expect(run.errors).toEqual([
      "Dispute disp_bad: could not serialize access",
    ]);
    expect(run).toMatchObject({ imported: 1, stoppedShort: null });
    expect(positionOf(run)).toEqual({ skip: 100, cutRuns: 0, deferred: [] });
  });

  it("raises the standing finding when a bound cuts the pass on a second run in a row", async () => {
    allKnownOpen();
    mockList.mockImplementation(async (_count: number, skip: number) =>
      fullPage(`disp_${skip}`),
    );
    mockReadCheckpoint.mockResolvedValue(
      JSON.stringify({ skip: 300, cutRuns: 1 }),
    );

    const run = await discoverGatewayDisputes(never);

    expect(positionOf(run)).toEqual({ skip: 600, cutRuns: 2, deferred: [] });
    expect(mockStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-disputes:discovery-cut",
        ids: ["pages"],
      }),
    );
  });

  it("does nothing and keeps the stored position when the gateway keys are absent", async () => {
    mockHasClient = false;

    const run = await discoverGatewayDisputes(never);

    expect(run.skipped).toBe(
      "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
    );
    expect(run.checkpoint).toBeUndefined();
    expect(mockList).not.toHaveBeenCalled();
  });
});
