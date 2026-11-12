/**
 * @jest-environment node
 */

/**
 * The class completion and its class-end refund markers commit together: the
 * stamp runs on the completing transaction after the CAS, and a CAS that lost
 * the race stamps nothing.
 */

import { IllegalTransitionError } from "@/lib/enterprise/transitions";

const mockTx = { tag: "completing-tx" };
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
        findMany: jest.fn(async () => [
          {
            id: "cls-1",
            status: "SCHEDULED",
            classPlan: { title: "Ten weeks of Python" },
            appointment: { occurrences: [] },
          },
        ]),
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
