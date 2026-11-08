/**
 * @jest-environment node
 */

/**
 * The editor sends a webinar's effective capacity on every save: an override
 * equal to the plan's default is stored as null, only a real raise stages the
 * seat-opened notices, and a shrink below the enrolled seats is refused.
 */

const mockTx = {
  webinarPlan: { update: jest.fn() },
  webinar: { update: jest.fn(), findUnique: jest.fn() },
  appointment: { findUnique: jest.fn() },
};

const transaction = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
    webinarPlan: { findUnique: jest.fn() },
    webinar: { findFirst: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

jest.mock("../../utils/contentValidation", () =>
  jest.requireActual("../fixtures/content-validation-stub"),
);

jest.mock("../../lib/topics", () => ({
  __esModule: true,
  findOrCreateTopics: jest.fn().mockResolvedValue(["topic-1"]),
  transformNestedPlanTopics: jest.fn((row: unknown) => row),
}));

jest.mock("../../lib/booking/event-waitlist", () => ({
  ...jest.requireActual("../../lib/booking/event-waitlist"),
  stageSeatOpenedNotices: jest.fn(async () => ({ pages: [], email: null })),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
}));

import prisma from "@/lib/prisma";
import { stageSeatOpenedNotices } from "@/lib/booking/event-waitlist";
import { PATCH } from "@/app/api/bookings/webinars/crud-with-plan/route";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PLAN = {
  id: "plan-1",
  consultantProfileId: "cp-1",
  consultantProfile: { id: "cp-1", userId: "user-1" },
  durationInHours: 1,
  maxParticipants: 10,
  topics: [],
  webinars: [],
};

function webinar(maxParticipants: number | null) {
  return {
    id: "web-1",
    status: "SCHEDULED",
    maxParticipants,
    appointment: { id: "appt-1", occurrences: [] },
  };
}

const seated = Array.from({ length: 5 }, (_, i) => ({ userId: `u-${i}` }));

function patch(maxParticipants?: number) {
  return PATCH({
    json: async () => ({
      id: "plan-1",
      webinarId: "web-1",
      title: "Renamed",
      ...(maxParticipants === undefined ? {} : { maxParticipants }),
    }),
  } as unknown as Parameters<typeof PATCH>[0]);
}

function given(override: number | null) {
  const row = webinar(override);
  base.webinar.findFirst.mockResolvedValue(row);
  mockTx.webinar.update.mockResolvedValue(row);
  mockTx.webinar.findUnique.mockResolvedValue(row);
}

const writtenCapacity = () =>
  mockTx.webinar.update.mock.calls.map(
    ([args]: [{ data: { maxParticipants?: number | null } }]) =>
      args.data.maxParticipants,
  );

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(mockTx),
  );
  base.webinarPlan.findUnique.mockResolvedValue(PLAN);
  mockTx.webinarPlan.update.mockResolvedValue(PLAN);
  mockTx.appointment.findUnique.mockResolvedValue({
    id: "appt-1",
    participants: seated,
  });
});

it("a title-only save leaves an unset override unset and stages nothing", async () => {
  given(null);
  expect((await patch(10)).status).toBe(200);
  expect(writtenCapacity()).toEqual([]);
  expect(stageSeatOpenedNotices).not.toHaveBeenCalled();
});

it("a save without a capacity changes none and stages nothing, whatever the editor loaded", async () => {
  given(null);
  expect((await patch()).status).toBe(200);
  expect(writtenCapacity()).toEqual([]);
  expect(mockTx.appointment.findUnique).not.toHaveBeenCalled();
  expect(stageSeatOpenedNotices).not.toHaveBeenCalled();
});

it("a raise above the enrolled seats writes the override and stages notices", async () => {
  given(null);
  expect((await patch(12)).status).toBe(200);
  expect(writtenCapacity()).toEqual([12]);
  expect(stageSeatOpenedNotices).toHaveBeenCalledWith(
    mockTx,
    "appt-1",
    expect.any(Date),
  );
});

it("a value equal to the plan's default clears the override", async () => {
  given(12);
  expect((await patch(10)).status).toBe(200);
  expect(writtenCapacity()).toEqual([null]);
  expect(stageSeatOpenedNotices).not.toHaveBeenCalled();
});

it("a capacity below the enrolled seats is refused", async () => {
  given(null);
  expect((await patch(4)).status).toBe(400);
  expect(mockTx.webinar.update).not.toHaveBeenCalled();
});
