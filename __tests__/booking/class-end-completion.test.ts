/**
 * @jest-environment node
 */

/**
 * The class completion and its class-end refund markers commit together: the
 * stamp runs on the completing transaction after the CAS, and a CAS that lost
 * the race stamps nothing.
 */

import { IllegalTransitionError } from "@/lib/enterprise/transitions";

const mockClassFindUnique = jest.fn();
const mockOccurrenceFindMany = jest.fn();
const mockStillEnded = jest.fn();
const mockClassRows = jest.fn();
const mockTx = {
  tag: "completing-tx",
  class: { findUnique: (...a: unknown[]) => mockClassFindUnique(...a) },
  appointment: { findFirst: (...a: unknown[]) => mockStillEnded(...a) },
  appointmentOccurrence: {
    findMany: (...a: unknown[]) => mockOccurrenceFindMany(...a),
  },
};
const PERIOD_OVER = new Date("2020-01-01T00:00:00.000Z");
const PERIOD_AHEAD = new Date("2999-01-01T00:00:00.000Z");
const ordinals = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ordinal: i + 1 }));
/** The cohort read's row: the period end, the sessions sold and the rows accounted for. */
const classRow = (
  schedulingPeriodEndsAt: Date,
  totalSessions: number,
  accountedRows: number,
) => ({
  id: "cls-1",
  status: "SCHEDULED",
  schedulingPeriodEndsAt,
  classPlan: { title: "Ten weeks of Python", totalSessions },
  appointment: { occurrences: [], _count: { occurrences: accountedRows } },
});
const mockTransitionClassEvent = jest.fn();
const mockStamp = jest.fn();
const mockTransaction = jest.fn(
  async (fn: (tx: unknown) => unknown, _opts?: unknown) => fn(mockTx),
);

jest.mock("../../lib/prisma", () => {
  const emptyTable = () => ({ findMany: jest.fn(async () => []) });
  return {
    __esModule: true,
    default: {
      class: {
        findMany: (...a: unknown[]) => mockClassRows(...a),
      },
      webinar: emptyTable(),
      consultation: emptyTable(),
      subscription: emptyTable(),
      trial: emptyTable(),
      appointmentOccurrence: emptyTable(),
      $transaction: (fn: (tx: unknown) => unknown, opts?: unknown) =>
        mockTransaction(fn, opts),
    },
  };
});
jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/booking/session-outcome-sweep", () => ({
  __esModule: true,
  OUTCOME_SLOT_SELECT: {},
  createStreamWitnessBudget: () => ({ remaining: 100, failures: 0 }),
  readOutageWindows: async () => [],
  alertStaleNeedsHuman: async () => undefined,
  escalateAgedNeedsHuman: async () => 0,
  confirmClosedOutcomes: async () => ({ confirmed: 0, weak: 0, errors: [] }),
  staleNeedsHumanWhere: () => ({}),
  decideSlotOutcome: async () => ({ kind: "deferred" }),
}));
jest.mock("../../lib/booking/transitions", () => ({
  ...jest.requireActual("../../lib/booking/transitions"),
  transitionClassEvent: (...a: unknown[]) => mockTransitionClassEvent(...a),
}));
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  stampClassEndRefundsOwed: (...a: unknown[]) => mockStamp(...a),
}));

import { autoCompleteAppointments } from "../../scripts/appointments/auto-complete-appointments";

beforeEach(() => {
  mockTransitionClassEvent.mockReset();
  mockStamp.mockReset();
  mockTransaction.mockClear();
  mockClassFindUnique.mockReset().mockResolvedValue({
    schedulingPeriodEndsAt: PERIOD_OVER,
    classPlan: { totalSessions: 96 },
  });
  mockOccurrenceFindMany.mockReset().mockResolvedValue(ordinals(8));
  mockStillEnded.mockReset().mockResolvedValue({ id: "apt-1" });
  mockClassRows.mockReset().mockResolvedValue([classRow(PERIOD_OVER, 96, 8)]);
});

it("stamps the class-end refunds on the completing transaction, after the CAS", async () => {
  const order: string[] = [];
  mockTransitionClassEvent.mockImplementation(async (tx: unknown) => {
    order.push("cas");
    expect(tx).toBe(mockTx);
  });
  mockStamp.mockImplementation(async (tx: unknown, classId: string) => {
    order.push("stamp");
    expect(tx).toBe(mockTx);
    expect(classId).toBe("cls-1");
    return { owed: 2, owedPaise: 4_000, escalated: 0 };
  });

  const result = await autoCompleteAppointments();

  expect(order).toEqual(["cas", "stamp"]);
  expect(mockTransitionClassEvent).toHaveBeenCalledWith(
    mockTx,
    expect.objectContaining({
      where: { id: "cls-1" },
      to: "COMPLETED",
    }),
  );
  expect(mockTransaction).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ timeout: 6_000 }),
  );
  expect(result.classesCompleted).toBe(1);
  expect(result.classEndSeatsOwed).toBe(2);
});

it("stamps nothing when the class moved since the cohort read", async () => {
  mockTransitionClassEvent.mockRejectedValue(
    new IllegalTransitionError("Class", "COMPLETED"),
  );

  const result = await autoCompleteAppointments();

  expect(mockStamp).not.toHaveBeenCalled();
  expect(result.classesCompleted).toBe(0);
  expect(result.errors).toEqual([]);
});

it("leaves the class open when a seat's payment owes another door's refund", async () => {
  mockTransitionClassEvent.mockResolvedValue(undefined);
  mockStamp.mockRejectedValue(
    Object.assign(new Error("refund in progress"), { httpStatus: 409 }),
  );

  const result = await autoCompleteAppointments();

  expect(result.classesCompleted).toBe(0);
  expect(result.errors).toEqual([
    expect.stringContaining("Failed to complete class cls-1"),
  ]);
});

describe("a class between batches", () => {
  beforeEach(() => {
    mockTransitionClassEvent.mockResolvedValue(undefined);
    mockStamp.mockResolvedValue({ owed: 0, owedPaise: 0, escalated: 0 });
  });

  it("stays open with 8 of 96 sessions placed and its period still running, without opening a transaction", async () => {
    mockClassRows.mockResolvedValue([classRow(PERIOD_AHEAD, 96, 8)]);

    const result = await autoCompleteAppointments();

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
    expect(result.classesCompleted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("completes once its period has ended, and refunds what was never placed", async () => {
    const result = await autoCompleteAppointments();

    expect(mockStamp).toHaveBeenCalledWith(mockTx, "cls-1");
    expect(result.classesCompleted).toBe(1);
  });

  it("stays open when the row count passes but two rows share an ordinal", async () => {
    // A cancelled session and its make-up are two rows and one session.
    mockClassRows.mockResolvedValue([classRow(PERIOD_AHEAD, 9, 9)]);
    mockClassFindUnique.mockResolvedValue({
      schedulingPeriodEndsAt: PERIOD_AHEAD,
      classPlan: { totalSessions: 9 },
    });

    const result = await autoCompleteAppointments();

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockStamp).not.toHaveBeenCalled();
    expect(result.classesCompleted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("stays open when a session was placed after the cohort read", async () => {
    mockStillEnded.mockResolvedValue(null);

    const result = await autoCompleteAppointments();

    expect(mockStamp).not.toHaveBeenCalled();
    expect(result.classesCompleted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("completes before its period ends once every sold session is placed", async () => {
    mockClassRows.mockResolvedValue([classRow(PERIOD_AHEAD, 8, 8)]);
    mockClassFindUnique.mockResolvedValue({
      schedulingPeriodEndsAt: PERIOD_AHEAD,
      classPlan: { totalSessions: 8 },
    });

    const result = await autoCompleteAppointments();

    expect(result.classesCompleted).toBe(1);
  });

  it("counts sessions by ordinal, with a host-cancelled session answered for", async () => {
    mockClassRows.mockResolvedValue([classRow(PERIOD_AHEAD, 8, 8)]);
    mockClassFindUnique.mockResolvedValue({
      schedulingPeriodEndsAt: PERIOD_AHEAD,
      classPlan: { totalSessions: 8 },
    });

    await autoCompleteAppointments();

    expect(mockOccurrenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ["ordinal"],
        where: expect.objectContaining({
          isTentative: false,
          deletedAt: null,
          appointment: { classId: "cls-1", deletedAt: null },
          OR: [
            { completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] } },
            { hostCancelledAt: { not: null } },
          ],
        }),
      }),
    );
  });
});
