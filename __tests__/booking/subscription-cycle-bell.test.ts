/**
 * @jest-environment node
 */

/**
 * #1766 — the consultee's "your cycle is done" bell is staged from the
 * completion path when the last live occurrence completes with entitlement
 * left, keyed on the cycle so a second pass over the same state (the
 * UNVERIFIED sweep after the webhook) reuses the outbox row.
 */

jest.mock("../../lib/novu/client", () => ({
  __esModule: true,
  isNovuConfigured: () => true,
  getNovuClient: () => {
    throw new Error("never sent in-tx");
  },
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { settleSubscriptionCycle } from "../../lib/booking/subscription-cycle";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-03-09T10:00:00.000Z");

function row(index: number, completionStatus: string) {
  const startsAt = new Date(NOW.getTime() - (5 - index) * 24 * HOUR);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus,
    isTentative: false,
    deletedAt: null,
  };
}

function wrapperWith(statuses: string[]) {
  return {
    organizationId: null,
    subscription: {
      id: "sub-1",
      status: "APPROVED",
      sessionsTotal: 12,
      schedulingPeriodStartsAt: new Date("2026-03-02T00:00:00.000Z"),
      schedulingTimezone: "UTC",
      requestedBy: { userId: "consultee-user" },
      subscriptionPlan: {
        title: "Intensive",
        totalSessions: 12,
        sessionsPerWeek: 4,
        durationInMonths: 3,
        consultantProfile: { user: { name: "Asha" } },
      },
    },
    occurrences: statuses.map((status, i) => row(i, status)),
  };
}

/** An outbox keyed like the real one: an upsert on transactionId is idempotent. */
function makeTx(statuses: string[]) {
  const rows = new Map<string, { id: string; transactionId: string }>();
  const upsert = jest.fn(
    ({
      where,
      create,
    }: {
      where: { transactionId: string };
      create: {
        transactionId: string;
        workflowId: string;
        payload: Record<string, unknown>;
      };
    }) => {
      const existing = rows.get(where.transactionId);
      const staged = existing ?? {
        id: `outbox-${rows.size + 1}`,
        transactionId: create.transactionId,
        workflowId: "subscription-renewed",
        kind: "SINGLE",
        recipients: ["consultee-user"],
        payload: create.payload,
        attempts: 0,
        status: "PENDING",
      };
      rows.set(where.transactionId, staged);
      return Promise.resolve(staged);
    },
  );
  return {
    tx: {
      appointment: {
        findUnique: jest.fn().mockResolvedValue(wrapperWith(statuses)),
      },
      notificationOutbox: { upsert },
      membership: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    },
    rows,
    upsert,
  };
}

const settle = (tx: ReturnType<typeof makeTx>["tx"]) =>
  settleSubscriptionCycle(tx as never, { appointmentId: "apt-1", now: NOW });

it("stages one row when the last live occurrence completes with 8 left", async () => {
  const { tx, upsert } = makeTx([
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
  ]);

  const staged = await settle(tx);

  expect(staged).toHaveLength(1);
  const { create } = upsert.mock.calls[0][0];
  expect(create.workflowId).toBe("subscription-renewed");
  expect(create.payload).toEqual(
    expect.objectContaining({
      cycleOrdinal: 1,
      remainingSessions: 8,
      nextBatch: 4,
      consultantName: "Asha",
      planTitle: "Intensive",
    }),
  );
});

it("a second pass (UNVERIFIED) over the same state reuses the dedupe key — no second row", async () => {
  const first = makeTx(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
  await settle(first.tx);
  const second = makeTx(["COMPLETED", "COMPLETED", "COMPLETED", "UNVERIFIED"]);
  await settle(second.tx);

  const key = (m: ReturnType<typeof makeTx>) =>
    m.upsert.mock.calls[0][0].where.transactionId;
  expect(key(second)).toBe(key(first));
});

it("stays silent while a session is still live or the plan is spent", async () => {
  const live = makeTx(["COMPLETED", "COMPLETED", "COMPLETED", "SCHEDULED"]);
  expect(await settle(live.tx)).toEqual([]);
  const spent = makeTx(Array(12).fill("COMPLETED"));
  expect(await settle(spent.tx)).toEqual([]);
  expect(live.upsert).not.toHaveBeenCalled();
  expect(spent.upsert).not.toHaveBeenCalled();
});
