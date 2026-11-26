/**
 * The allocator takes the slot atoms of every time it places, after its search
 * and never waiting: a held time is excluded and searched around (at most
 * twice, inside one shared search budget), then the answer is a retryable
 * ALLOCATION_RACE. The consultee lock is held only from the batch to the
 * write, never across a search, and the batch is released after the write.
 */
import "./setup";

// The in-transaction availability re-read has its own suite; these isolate the allocator.
// The database's host-time locks are pinned in host-time-locks.test.ts.
jest.mock("../../lib/booking/allocation/host-time-locks", () => ({
  lockHostTimeInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/allocation/coverage", () => ({
  assertSlotsStillPublished: jest.fn(async () => undefined),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest.fn().mockResolvedValue({ key: "auto" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest.fn().mockResolvedValue({ key: "consultee" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
  tryLockSlotBatch: jest.fn(),
  extendSlotInterval: jest.fn().mockResolvedValue(true),
  unlockSlotInterval: jest.fn().mockResolvedValue(undefined),
  // `slot-booking:<cp>:<atomISO>`, the key shape a refused batch reports.
  parseSlotKey: (key: string) => {
    const [, consultantProfileId, ...iso] = key.split(":");
    const startsAt = new Date(iso.join(":"));
    return { consultantProfileId, startsAt, endsAt: startsAt };
  },
}));

jest.mock("../../lib/booking/allocation/identity", () => ({
  getConsultantProfileId: jest.fn().mockResolvedValue("cp-host"),
  getConsulteeUserId: jest.fn().mockResolvedValue("u-buyer"),
  getEventRelationField: () => "consultation",
}));
jest.mock("../../lib/booking/allocation/event-data", () => ({
  fetchEventData: jest.fn().mockResolvedValue({
    consultant: { userId: "u-host", scheduleType: "WEEKLY" },
    config: { durationInHours: 1 },
    consulteeUserId: "u-buyer",
    organizationId: null,
    planId: "plan-1",
  }),
  updateEventStatus: jest.fn().mockResolvedValue("approved"),
  holdUntilPaid: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/booking/allocation/search/find-available-slots", () => ({
  findAvailableSlots: jest.fn(),
}));
jest.mock("../../lib/booking/allocation/idempotency", () => ({
  findIdempotentAllocation: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../lib/booking/allocation/preference", () => ({
  findAllocationPreference: jest.fn().mockResolvedValue(undefined),
  resolveConsumedPreferenceRequests: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/booking/allocation/guards", () => ({
  ...jest.requireActual("../../lib/booking/allocation/guards"),
  guardAllocationInTx: jest.fn().mockResolvedValue(null),
  assertExpectedTentativeSlotCountInTx: jest.fn().mockResolvedValue(undefined),
  assertNoConfirmedSlots: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/booking/allocation/collaborators", () => ({
  assertCollaboratorsFree: jest.fn().mockResolvedValue(undefined),
  lockPlanForAllocation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/booking/allocation/commit/release-tentative", () => ({
  deleteExistingAppointments: jest.fn().mockResolvedValue({
    enrolledUserIds: [],
    deletedAppointmentIds: [],
    freedOrdinals: [],
    freedWindows: [],
    reusableAppointmentId: undefined,
  }),
}));
jest.mock("../../lib/booking/allocation/commit/create-appointments", () => ({
  createAppointments: jest
    .fn()
    .mockResolvedValue({ appointments: [], overageNotice: null }),
}));
jest.mock("../../lib/booking/allocation/notify", () => ({
  stageAllocationNotices: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    validate: async () => ({ isValid: true, errors: [], warnings: [] }),
    revalidateConflicts: async () => ({
      isValid: true,
      errors: [],
      warnings: [],
    }),
  })),
}));

import { autoAllocate } from "@/lib/booking/allocation/modes/auto";
import {
  lockConsulteeBooking,
  tryLockSlotBatch,
  unlockConsulteeBooking,
  unlockSlotInterval,
} from "@/utils/appointmentlock";
import { findAvailableSlots } from "@/lib/booking/allocation/search/find-available-slots";

const tryLock = tryLockSlotBatch as jest.Mock;
const search = findAvailableSlots as jest.Mock;
const T1 = new Date("2031-03-03T10:00:00.000Z");
const T2 = new Date("2031-03-03T14:00:00.000Z");
const halfHour = (d: Date) => new Date(d.getTime() + 30 * 60_000);
const heldAt = (d: Date) => ({
  ok: false,
  heldKeys: [`slot-booking:cp-host:${d.toISOString()}`],
});

beforeEach(() => {
  jest.clearAllMocks();
  tryLock.mockReset();
  search
    .mockReset()
    .mockResolvedValueOnce([T1, halfHour(T1)])
    .mockResolvedValueOnce([T2, halfHour(T2)])
    .mockResolvedValue([T2, halfHour(T2)]);
});

it("takes the atoms of the chosen times after the search and the consultee lock", async () => {
  tryLock.mockResolvedValueOnce({ ok: true, grant: [{ key: "k" }] });

  const result = await autoAllocate("consultation", "cons-1");

  expect(result.success).toBe(true);
  const [entries] = tryLock.mock.calls[0];
  expect(entries).toEqual([
    expect.objectContaining({ consultantProfileId: "cp-host", startsAt: T1 }),
    expect.objectContaining({
      consultantProfileId: "cp-host",
      startsAt: halfHour(T1),
    }),
  ]);
  const searchedAt = search.mock.invocationCallOrder[0];
  const consulteeAt = (lockConsulteeBooking as jest.Mock).mock
    .invocationCallOrder[0];
  expect(consulteeAt).toBeGreaterThan(searchedAt);
  expect(tryLock.mock.invocationCallOrder[0]).toBeGreaterThan(consulteeAt);
  expect(unlockSlotInterval).toHaveBeenCalledWith([{ key: "k" }]);
});

it("searches around a time another writer holds, then places the free one", async () => {
  tryLock
    .mockResolvedValueOnce(heldAt(T1))
    .mockResolvedValueOnce({ ok: true, grant: [{ key: "k2" }] });

  const result = await autoAllocate("consultation", "cons-1");

  expect(result.success).toBe(true);
  expect(search).toHaveBeenCalledTimes(2);
  // The re-search treats the held interval as booked.
  const heldArg = search.mock.calls[1][search.mock.calls[1].length - 3];
  expect(heldArg).toEqual([T1.toISOString()]);
  expect(tryLock.mock.calls[1][0][0]).toMatchObject({ startsAt: T2 });
});

it("answers a retryable ALLOCATION_RACE after two re-searches, never a partial", async () => {
  tryLock
    .mockResolvedValueOnce(heldAt(T1))
    .mockResolvedValueOnce(heldAt(T2))
    .mockResolvedValueOnce(heldAt(T2));

  await expect(autoAllocate("consultation", "cons-1")).rejects.toMatchObject({
    errorCode: "ALLOCATION_RACE",
    httpStatus: 409,
  });
  expect(search).toHaveBeenCalledTimes(3);
  expect(unlockSlotInterval).not.toHaveBeenCalled();
});

it("gives the consultee lock back before it re-searches", async () => {
  tryLock
    .mockResolvedValueOnce(heldAt(T1))
    .mockResolvedValueOnce({ ok: true, grant: [{ key: "k2" }] });

  await autoAllocate("consultation", "cons-1");

  const released = (unlockConsulteeBooking as jest.Mock).mock
    .invocationCallOrder[0];
  expect(released).toBeLessThan(search.mock.invocationCallOrder[1]);
  expect(lockConsulteeBooking).toHaveBeenCalledTimes(2);
  expect(unlockConsulteeBooking).toHaveBeenCalledTimes(2);
});

it("shares one search budget across the first search and every re-search", async () => {
  tryLock
    .mockResolvedValueOnce(heldAt(T1))
    .mockResolvedValueOnce({ ok: true, grant: [{ key: "k2" }] });

  await autoAllocate("consultation", "cons-1");

  const budgetOf = (call: unknown[]) => call[call.length - 2];
  expect(budgetOf(search.mock.calls[0])).toBeDefined();
  expect(budgetOf(search.mock.calls[1])).toBe(budgetOf(search.mock.calls[0]));
});

it("answers ALLOCATION_RACE without re-searching once the shared budget is spent", async () => {
  let clock = 1_000_000;
  const now = jest.spyOn(Date, "now").mockImplementation(() => clock);
  search.mockReset().mockImplementationOnce(async () => {
    clock += 11_000;
    return [T1, halfHour(T1)];
  });
  tryLock.mockResolvedValueOnce(heldAt(T1));

  try {
    await expect(autoAllocate("consultation", "cons-1")).rejects.toMatchObject({
      errorCode: "ALLOCATION_RACE",
    });
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});
