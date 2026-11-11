/**
 * Lock order event checkout → appointment → auto-allocate → consultee → slot
 * batch: a webinar or class plans under its checkout key, an event that already
 * has its booking wrapper runs under that wrapper's appointment lock, and a
 * caller that already holds it hands it over instead.
 */
import "./setup";

const mockFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    // The allocator counts what the event already holds to record how it was scheduled.
    appointmentOccurrence: { count: jest.fn().mockResolvedValue(0) },
    appointment: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
  },
}));
const mockOrder: string[] = [];
jest.mock("../../utils/appointmentlock", () => ({
  withEventCheckoutLock: jest.fn(
    async (
      key: { appointmentType: string; eventId: string } | null,
      fn: (renew: () => Promise<void>) => Promise<unknown>,
    ) => {
      if (key) mockOrder.push(`event:${key.appointmentType}:${key.eventId}`);
      return fn(async () => undefined);
    },
  ),
  withAppointmentLock: jest.fn(
    async (id: string, fn: (lock: unknown) => Promise<unknown>) => {
      mockOrder.push(`lock:${id}`);
      return fn({ key: `appointment-lock:${id}` });
    },
  ),
  renewAppointmentLock: jest.fn(async () => {
    mockOrder.push("renew");
    return true;
  }),
}));
jest.mock("../../lib/booking/allocation/modes/auto", () => ({
  autoAllocate: jest.fn(async () => {
    mockOrder.push("allocate");
    return { success: true, appointments: [] };
  }),
}));
jest.mock("../../lib/booking/allocation/modes/manual", () => ({
  manualAllocate: jest.fn(),
}));
jest.mock("../../lib/booking/allocation/modes/use-requested", () => ({
  useRequestedSlots: jest.fn(),
}));

import { allocate } from "@/lib/booking/allocation/allocate";
import type { ApprovalLock } from "@/utils/appointmentlock";

beforeEach(() => {
  mockOrder.length = 0;
  mockFindFirst.mockReset();
});

it("allocates an existing booking under its appointment lock", async () => {
  mockFindFirst.mockResolvedValue({ id: "appt-1" });

  const result = await allocate({
    eventType: "consultation",
    eventId: "cons-1",
    mode: "auto",
  });

  expect(result.success).toBe(true);
  expect(mockOrder).toEqual(["lock:appt-1", "allocate"]);
});

it("renews the grant a reschedule accept already holds instead of re-acquiring it", async () => {
  await allocate({
    eventType: "consultation",
    eventId: "cons-1",
    mode: "auto",
    heldAppointmentLock: { key: "appointment-lock:appt-1" } as ApprovalLock,
  });

  expect(mockOrder).toEqual(["renew", "allocate"]);
  expect(mockFindFirst).not.toHaveBeenCalled();
});

it("holds only the checkout key when the event has no booking yet", async () => {
  mockFindFirst.mockResolvedValue(null);

  await allocate({ eventType: "webinar", eventId: "web-1", mode: "auto" });

  expect(mockOrder).toEqual(["event:WEBINAR:web-1", "allocate"]);
});

it("re-plans a class under its checkout key before its appointment lock", async () => {
  mockFindFirst.mockResolvedValue({ id: "appt-1" });

  await allocate({ eventType: "class", eventId: "class-1", mode: "auto" });

  expect(mockOrder).toEqual(["event:CLASS:class-1", "lock:appt-1", "allocate"]);
});
