/**
 * @jest-environment node
 */

/**
 * A conduct removal waits on its support case. A decided case marks the removal
 * upheld or overturned; a case support leaves undecided past its deadline
 * refunds the attendee in full and releases the host's hold.
 */
const mockTx = {
  participantRemoval: {
    updateMany: jest.fn(async (..._args: unknown[]) => ({ count: 1 })),
  },
  supportCase: {
    update: jest.fn(async (..._args: unknown[]) => ({ messageSeq: 3 })),
  },
  supportCaseMessage: { create: jest.fn(async (..._args: unknown[]) => ({})) },
};
const mockPrisma = {
  participantRemoval: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(async (..._args: unknown[]) => ({ count: 1 })),
  },
  payment: { count: jest.fn() },
  refund: { count: jest.fn() },
  $transaction: jest.fn(async (fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  ),
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
  ALLOCATION_TX_MAX_WAIT_MS: 1000,
  ALLOCATION_TX_TIMEOUT_MS: 1000,
}));
const mockRefund = jest.fn();
jest.mock("@/lib/payments/operations/event-refunds", () => ({
  refundRemovedAttendeeSeat: (...args: unknown[]) => mockRefund(...args),
}));
const mockReleaseHolds = jest.fn(async (..._args: unknown[]) => []);
jest.mock("@/lib/support/case-holds", () => ({
  releaseAllCaseHolds: (...args: unknown[]) => mockReleaseHolds(...args),
}));
const mockStageBell = jest.fn(async (..._args: unknown[]) => ({
  id: "bell-1",
}));
jest.mock("@/lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockStageBell(...args),
}));

import type { StagedTrigger } from "@/lib/novu/outbox";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const removal = {
  id: "rem-1",
  userId: "attendee-1",
  appointmentId: "appt-1",
  createdAt: new Date("2026-11-01T10:00:00.000Z"),
  supportCaseId: "case-1",
  appointment: { webinar: { id: "web-1" }, class: null },
};

const sweep = async () =>
  (await import("@/lib/support/removal-review")).sweepRemovalReviews({
    limit: 5,
    now: NOW,
    errors: errors,
    stagedBells: stagedBells,
  });
let errors: string[];
let stagedBells: StagedTrigger[];

beforeEach(() => {
  jest.clearAllMocks();
  errors = [];
  stagedBells = [];
  mockPrisma.participantRemoval.findMany.mockResolvedValue([]);
});

/** First findMany is the decided batch, the second the overdue batch. */
function queue(decided: unknown[], overdue: unknown[]) {
  mockPrisma.participantRemoval.findMany
    .mockResolvedValueOnce(decided)
    .mockResolvedValueOnce(overdue);
}

describe("decided removals", () => {
  it("upholds a removal whose case closed with no refund to the attendee", async () => {
    queue([removal], []);
    mockPrisma.refund.count.mockResolvedValue(0);
    const result = await sweep();
    expect(result.decided).toBe(1);
    expect(mockPrisma.participantRemoval.updateMany).toHaveBeenCalledWith({
      where: { id: "rem-1", status: "PENDING_REVIEW" },
      data: { status: "UPHELD", decidedAt: expect.any(Date) },
    });
  });

  it("marks a removal overturned when a refund went out after it", async () => {
    queue([removal], []);
    mockPrisma.refund.count.mockResolvedValue(1);
    await sweep();
    expect(mockPrisma.participantRemoval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "OVERTURNED", decidedAt: expect.any(Date) },
      }),
    );
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

describe("removals past the support deadline", () => {
  it("refunds in full, releases the hold, tells the attendee and overturns", async () => {
    queue([], [removal]);
    mockPrisma.payment.count.mockResolvedValue(1);
    // Nothing refunded before the attempt, refunded after it.
    mockPrisma.refund.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const result = await sweep();

    expect(mockRefund).toHaveBeenCalledWith({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: "attendee-1",
      initiatedByUserId: null,
      mode: "full",
      dedupeKey: "removal-review:rem-1",
    });
    expect(mockTx.participantRemoval.updateMany).toHaveBeenCalledWith({
      where: { id: "rem-1", status: "PENDING_REVIEW" },
      data: { status: "OVERTURNED", decidedAt: expect.any(Date) },
    });
    expect(mockReleaseHolds).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ caseId: "case-1", actorId: null }),
    );
    expect(mockTx.supportCaseMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseId: "case-1",
        seq: 3,
        isInternal: false,
      }),
    });
    expect(mockStageBell).toHaveBeenCalledWith(mockTx, expect.anything());
    expect(stagedBells).toHaveLength(1);
    expect(result.refundedOnDeadline).toBe(1);
    expect(errors).toEqual([]);
  });

  it("does not overturn, and reports once, when the refund did not land", async () => {
    queue([], [removal]);
    mockPrisma.payment.count.mockResolvedValue(1);
    mockPrisma.refund.count.mockResolvedValue(0);
    const result = await sweep();
    expect(mockRefund).toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(result.refundedOnDeadline).toBe(0);
    expect(errors).toEqual([
      "removal-review rem-1: deadline refund did not land",
    ]);
  });

  it("does not refund twice when a refund already went out", async () => {
    queue([], [removal]);
    mockPrisma.payment.count.mockResolvedValue(1);
    mockPrisma.refund.count.mockResolvedValue(1);
    await sweep();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockTx.participantRemoval.updateMany).toHaveBeenCalled();
  });

  it("overturns without a refund call when the seat was never paid", async () => {
    queue([], [removal]);
    mockPrisma.payment.count.mockResolvedValue(0);
    const result = await sweep();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(result.refundedOnDeadline).toBe(1);
  });

  it("keeps sweeping after one removal throws", async () => {
    const second = { ...removal, id: "rem-2" };
    queue([], [removal, second]);
    mockPrisma.payment.count
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(0);
    const result = await sweep();
    expect(errors).toEqual(["removal-review rem-1: db down"]);
    expect(result.refundedOnDeadline).toBe(1);
  });
});
