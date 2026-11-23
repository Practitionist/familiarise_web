/**
 * @jest-environment node
 */

// Invariant: one auto-complete run keeps deciding past its first bite while the time budget lasts, so a backlog drains.

import "../../booking-algorithm/setup";

type Slot = { id: string; startsAt: Date; endsAt: Date; appointmentId: string };

const BITE = 25;
const BACKLOG = 100;
let queue: Slot[] = [];
const decided: string[] = [];
const confirmDeadlines: boolean[] = [];

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: jest.requireActual("./checkout-harness/setup").db,
}));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../../lib/booking/session-outcome-sweep", () => ({
  __esModule: true,
  OUTCOME_SLOT_SELECT: {},
  readOutageWindows: async () => [],
  alertStaleNeedsHuman: async () => undefined,
  escalateAgedNeedsHuman: async () => 0,
  confirmClosedOutcomes: async (_now: Date, pastDeadline: () => boolean) => {
    confirmDeadlines.push(pastDeadline());
    return { confirmed: 0, weak: 0, errors: [], checkpoint: null };
  },
  decideSlotOutcome: async (slot: Slot) => {
    decided.push(slot.id);
    queue = queue.filter((s) => s.id !== slot.id);
    return {
      kind: "written",
      to: "COMPLETED",
      verdict: "attended",
      moved: true,
    };
  },
}));
jest.mock("../../../lib/email/senders/booking", () => ({
  __esModule: true,
  stageAppointmentCompletedEmails: jest.fn(async () => []),
  stageSubscriptionLifecycleEmail: jest.fn(async () => []),
  stageTrialLifecycleEmail: jest.fn(async () => []),
}));
jest.mock("../../../lib/novu/service", () => ({
  __esModule: true,
  notifyAppointmentCompleted: jest.fn(async () => []),
  notifyTrialCompleted: jest.fn(async () => []),
}));
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import { autoCompleteAppointments } from "../../../scripts/appointments/auto-complete-appointments";
import { calls, resetDouble } from "./checkout-harness/setup";

beforeEach(() => {
  decided.length = 0;
  confirmDeadlines.length = 0;
  queue = Array.from({ length: BACKLOG }, (_, i) => ({
    id: `slot-${i}`,
    startsAt: new Date(Date.now() - 5 * 3600_000),
    endsAt: new Date(Date.now() - 4 * 3600_000),
    appointmentId: `appt-${i}`,
  }));
  resetDouble({
    "appointmentOccurrence.findMany": (args) => {
      const take = (args as { take?: number }).take ?? queue.length;
      return queue.slice(0, take).map((s) => ({ ...s, appointment: {} }));
    },
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("autoCompleteAppointments backlog", () => {
  it("decides the whole backlog in one run, not just the first bite", async () => {
    await autoCompleteAppointments({ maxParents: BITE, maxSlotOutcomes: BITE });

    expect(decided).toHaveLength(BACKLOG);
  });

  it("stops starting sessions at half the start budget, leaving the rest to the next run", async () => {
    const startedAt = Date.now();
    // Each decision costs one simulated second of the 16 s budget.
    jest
      .spyOn(Date, "now")
      .mockImplementation(() => startedAt + decided.length * 1000);

    await autoCompleteAppointments({
      maxParents: BITE,
      maxSlotOutcomes: BITE,
      startedAt,
    });

    // Sessions settle from Stream, so they get half the 16 s start budget, as classes do.
    expect(decided).toHaveLength(8);
  });

  it("measures the window-close pass's share from the request's start, so a slow start leaves it no time", async () => {
    // Setup and the lock took 5 s, past the pass's quarter of the 16 s budget.
    const startedAt = Date.now() - 5000;

    await autoCompleteAppointments({
      maxParents: BITE,
      maxSlotOutcomes: BITE,
      startedAt,
    });

    expect(confirmDeadlines).toEqual([true]);
    expect(decided.length).toBeGreaterThan(0);
  });

  it("re-reads parents while the slot pass is still draining", async () => {
    await autoCompleteAppointments({ maxParents: BITE, maxSlotOutcomes: BITE });

    const webinarReads = calls.filter((c) => c.path === "webinar.findMany");
    // Four full slot bites, then one short: the parent pass reads every round.
    expect(webinarReads).toHaveLength(5);
  });
});
