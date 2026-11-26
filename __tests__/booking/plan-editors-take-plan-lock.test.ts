/**
 * @jest-environment node
 */

/**
 * A plan editor that takes host time takes the plan row as its first row lock
 * and refuses a team its calendar batch did not cover, before it writes a
 * session.
 */

/** Every call the transaction receives, in order. */
const txLog: string[] = [];
const PLAN_LOCK = "plan row";
const mockTx = new Proxy(
  {},
  {
    get: (_tx, model) => {
      if (typeof model !== "string" || model === "then") return undefined;
      if (model === "$executeRaw") {
        return async (sql: TemplateStringsArray) => {
          txLog.push(`${PLAN_LOCK}: ${sql.join("?").trim()}`);
          return 1;
        };
      }
      return new Proxy(
        {},
        {
          get: (_model, method) => async () => {
            txLog.push(`${model}.${String(method)}`);
            // Inside the transaction the team holds an expert accepted since the batch was taken.
            return model === "collaborator"
              ? [{ consultantProfileId: "cp-accepted-since" }]
              : null;
          },
        },
      );
    },
  },
);

// The database's host-time locks are pinned in host-time-locks.test.ts.
jest.mock("../../lib/booking/allocation/host-time-locks", () => ({
  lockHostTimeInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback(mockTx),
    webinarPlan: { findUnique: jest.fn() },
    webinar: { findFirst: jest.fn() },
    classPlan: { findUnique: jest.fn() },
    class: { findFirst: jest.fn() },
    appointmentOccurrence: { findMany: jest.fn(), count: jest.fn() },
    // The team as the editor reads it before it takes its batch: the host alone.
    collaborator: { findMany: jest.fn(async () => []) },
    membership: { count: jest.fn(async () => 0) },
  },
}));
jest.mock("../../lib/booking/host-slot-batch", () => ({
  ...jest.requireActual("../../lib/booking/host-slot-batch"),
  withHostSlotBatch: (
    _entries: unknown,
    run: (renew: () => Promise<void>) => unknown,
  ) => run(async () => {}),
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
  findOrCreateTopics: jest.fn(),
  transformNestedPlanTopics: jest.fn((row: unknown) => row),
}));

import prisma from "@/lib/prisma";
import { PATCH as patchClass } from "@/app/api/bookings/classes/crud-with-plan/route";
import { PATCH as patchWebinar } from "@/app/api/bookings/webinars/crud-with-plan/route";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SESSION = {
  startsAt: new Date("2031-03-03T10:00:00.000Z"),
  endsAt: new Date("2031-03-03T11:00:00.000Z"),
  completionStatus: "SCHEDULED",
  deletedAt: null,
};
const PLAN = {
  id: "plan-1",
  consultantProfileId: "cp-1",
  consultantProfile: { id: "cp-1", userId: "user-1" },
  durationInHours: 1,
  sessionsPerWeek: 1,
  durationInMonths: 1,
  sessionDurationInHours: 1,
  topics: [],
  classContents: [],
  webinars: [],
  classes: [],
};

function request(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof patchWebinar>[0];
}

/** The answer, and every call the transaction received before it. */
async function outcomeOf(response: Response) {
  const body: { error?: string } = await response.json();
  return { status: response.status, error: body.error, calls: [...txLog] };
}

/** A refusal that took the plan row, read the team, and touched nothing else. */
const refusedBehindThePlanLock = (table: string) => ({
  status: 409,
  error: expect.stringMatching(/being booked right now/),
  calls: [
    `${PLAN_LOCK}: UPDATE "${table}" SET "updatedAt" = "updatedAt" WHERE "id" = ?`,
    "collaborator.findMany",
  ],
});

beforeEach(() => {
  txLog.length = 0;
  base.webinarPlan.findUnique.mockResolvedValue(PLAN);
  base.classPlan.findUnique.mockResolvedValue(PLAN);
  base.appointmentOccurrence.findMany.mockResolvedValue([SESSION]);
  base.appointmentOccurrence.count.mockResolvedValue(1);
});

describe("a plan editor whose calendar batch missed a member of the team", () => {
  it("refuses a webinar's move before any session is written", async () => {
    base.webinar.findFirst.mockResolvedValue({
      id: "web-1",
      status: "SCHEDULED",
      appointment: { id: "appt-1", occurrences: [SESSION] },
    });

    const response = await patchWebinar(
      request({
        id: "plan-1",
        webinarId: "web-1",
        scheduledAt: "2031-03-04T10:00:00.000Z",
      }),
    );

    expect(await outcomeOf(response)).toEqual(
      refusedBehindThePlanLock("WebinarPlan"),
    );
  });

  it("refuses a class's new period before any session is written", async () => {
    base.class.findFirst.mockResolvedValue({
      id: "class-1",
      status: "SCHEDULED",
      schedulingPeriodStartsAt: new Date("2031-03-03T10:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2031-04-03T10:00:00.000Z"),
    });

    const response = await patchClass(
      request({
        id: "plan-1",
        classId: "class-1",
        startDate: "2031-03-10T10:00:00.000Z",
      }),
    );

    expect(await outcomeOf(response)).toEqual(
      refusedBehindThePlanLock("ClassPlan"),
    );
  });
});
