/**
 * @jest-environment node
 */

/**
 * The settle sweep converges after a kill, applies a plan extension once,
 * rotates a refund-owed marker conflict and reports it once per run,
 * dead-letters a row at the retire count, and yields to a free rebook.
 */

type Row = {
  id: string;
  incidentId: string;
  occurrenceId: string;
  userId: string;
  paymentId: string | null;
  kind: string;
  dueAt: Date;
  doneAt: Date | null;
  notifiedAt: Date | null;
  attempts: number;
  lastError: string | null;
  updatedAt: number;
};

jest.mock("../../lib/prisma", () => {
  const state = { rows: [] as Row[], tick: 0 };
  const matches = (r: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "id" && v && typeof v === "object") {
        return !(v as { notIn: string[] }).notIn.includes(r.id);
      }
      if (k === "dueAt") return r.dueAt <= (v as { lte: Date }).lte;
      if (k === "attempts" && v && typeof v === "object") {
        return r.attempts < (v as { lt: number }).lt;
      }
      if (k === "kind" && v && typeof v === "object") {
        return (v as { in: string[] }).in.includes(r.kind);
      }
      if (k === "OR") {
        return (v as Record<string, unknown>[]).some((w) => matches(r, w));
      }
      return (r as Record<string, unknown>)[k] === v;
    });
  const withOcc = (r: Row) => ({
    ...r,
    occurrence: {
      appointmentId: "appt-1",
      completionStatus: "VOIDED",
      appointment: { subscriptionId: "sub-1", trial: null },
    },
  });
  const client: Record<string, unknown> = {
    __state: state,
    platformIncident: {
      findMany: jest.fn(async () => [
        {
          id: "inc-1",
          startsAt: new Date(0),
          endsAt: new Date(1),
          enumeratedAt: new Date(1),
          reportedAt: null,
        },
      ]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    incidentRemedy: {
      findMany: jest.fn(async ({ where, take }) =>
        state.rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, take)
          .map(withOcc),
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        const hit = state.rows.filter((r) => matches(r, where));
        for (const r of hit)
          Object.assign(r, data, { updatedAt: ++state.tick });
        return { count: hit.length };
      }),
      count: jest.fn(
        async ({ where }) => state.rows.filter((r) => matches(r, where)).length,
      ),
      findUnique: jest.fn(async ({ where }) => {
        const r = state.rows.find((x) => x.id === where.id);
        return r ? { doneAt: r.doneAt } : null;
      }),
    },
    appointmentOccurrence: {
      findUnique: jest.fn(async () => ({ completionStatus: "VOIDED" })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_k: string, _o: unknown, fn: () => unknown) => fn(),
}));
const mockOnLock = jest.fn();
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => {
    mockOnLock();
    return fn();
  },
}));
const extendPlan = jest.fn(async () => true);
jest.mock("../../lib/booking/platform-incidents", () => ({
  ...jest.requireActual("../../lib/booking/platform-incidents"),
  enumerateIncident: jest.fn(async () => true),
  // The claim report has its own suites.
  reportClaimedNoShows: jest.fn(async () => []),
  incidentsWithUnreportedClaims: jest.fn(async () => []),
  extendPlanForIncident: (...a: unknown[]) => extendPlan(...(a as [])),
  freeTrialPair: jest.fn(async () => true),
}));
const refundIncidentSeat = jest.fn();
jest.mock("../../lib/payments/operations/incident-refunds", () => ({
  refundIncidentSeat: (...a: unknown[]) => refundIncidentSeat(...a),
}));
jest.mock("../../lib/booking/platform-incident-notices", () => ({
  sendIncidentDigests: jest.fn(async () => 0),
  stageAndSendIncidentReport: jest.fn(async () => 1),
}));
const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));

import prisma from "../../lib/prisma";
import { settlePlatformIncidents } from "../../scripts/appointments/settle-platform-incidents";

const state = (prisma as unknown as { __state: { rows: Row[] } }).__state;

function remedy(over: Partial<Row>): Row {
  return {
    id: "rem-1",
    incidentId: "inc-1",
    occurrenceId: "occ-1",
    userId: "u1",
    paymentId: "pay-1",
    kind: "REFUND_AT_DUE",
    dueAt: new Date(0),
    doneAt: null,
    notifiedAt: new Date(0),
    attempts: 0,
    lastError: null,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
});

it("extends a plan once across two runs", async () => {
  state.rows = [remedy({ kind: "SUBSCRIPTION_EXTEND", paymentId: null })];
  await settlePlatformIncidents();
  await settlePlatformIncidents();
  expect(extendPlan).toHaveBeenCalledTimes(1);
  expect(state.rows[0].doneAt).not.toBeNull();
});

it("converges after a run that died mid-refund", async () => {
  state.rows = [remedy({})];
  refundIncidentSeat.mockRejectedValueOnce(new Error("lock held"));
  const first = await settlePlatformIncidents();
  expect(first.errors).toBe(1);
  expect(state.rows[0]).toMatchObject({ doneAt: null, attempts: 0 });

  refundIncidentSeat.mockResolvedValueOnce({ kind: "done", refundedPaise: 1 });
  const second = await settlePlatformIncidents();
  expect(second.remediesDone).toBe(1);
  expect(prisma.appointmentOccurrence.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: { seatsSettledAt: expect.any(Date) } }),
  );
});

it("rotates marker conflicts and reports them once per run", async () => {
  state.rows = [remedy({}), remedy({ id: "rem-2", userId: "u2" })];
  refundIncidentSeat.mockResolvedValue({
    kind: "conflict",
    heldKey: "trial-cancel:t:pay-1",
  });
  const result = await settlePlatformIncidents();
  expect(result.remediesRetried).toBe(2);
  expect(state.rows.map((r) => r.attempts)).toEqual([1, 1]);
  expect(state.rows[0].lastError).toMatch(/^marker conflict/);
  const retryReports = reportSentryError.mock.calls.filter(
    ([, opts]) => opts.op === "settle-platform-incidents.retry",
  );
  expect(retryReports).toHaveLength(1);
});

it("dead-letters a row at the retire count and leaves it out of the cohort", async () => {
  state.rows = [remedy({ attempts: 2 })];
  refundIncidentSeat.mockResolvedValue({
    kind: "failed",
    error: new Error("gateway down"),
  });
  const result = await settlePlatformIncidents();
  expect(result.deadLettered).toBe(1);
  expect(state.rows[0].lastError).toMatch(/^dead-letter:/);

  refundIncidentSeat.mockClear();
  await settlePlatformIncidents();
  expect(refundIncidentSeat).not.toHaveBeenCalled();
});

it("waits quietly behind a dispute: no attempt counted, never dead-lettered", async () => {
  state.rows = [remedy({ attempts: 2 })];
  refundIncidentSeat.mockResolvedValue({ kind: "blocked" });
  const result = await settlePlatformIncidents();
  expect(state.rows[0]).toMatchObject({ attempts: 2, doneAt: null });
  expect(result.deadLettered).toBe(0);
  expect(result.settled).toBe(0);
});

it("skips the refund of a session ops un-voided, and stamps a replay done once", async () => {
  state.rows = [remedy({}), remedy({ id: "rem-2", userId: "u2" })];
  (prisma.appointmentOccurrence.findUnique as jest.Mock)
    .mockResolvedValueOnce({ completionStatus: "COMPLETED" })
    .mockResolvedValueOnce({ completionStatus: "VOIDED" });
  refundIncidentSeat.mockResolvedValue({ kind: "done", refundedPaise: 0 });
  await settlePlatformIncidents();
  await settlePlatformIncidents();
  expect(refundIncidentSeat).toHaveBeenCalledTimes(1);
  expect(state.rows[0].lastError).toMatch(/no longer voided/);
  expect(state.rows.every((r) => r.doneAt)).toBe(true);
});

it("yields to a free rebook that committed while it waited for the lock", async () => {
  state.rows = [remedy({})];
  mockOnLock.mockImplementationOnce(() => {
    state.rows[0].doneAt = new Date();
  });
  const result = await settlePlatformIncidents();
  expect(refundIncidentSeat).not.toHaveBeenCalled();
  expect(result).toMatchObject({ remediesDone: 0, errors: 0 });
});
