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

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { settleSubscriptionCycle } from "../../lib/booking/subscription-cycle";
import { B2C_TEMPLATES } from "../../lib/novu/templates/b2c";
import { NOVU_WORKFLOWS } from "../../lib/novu/workflows";
import { TrialAndSubscriptionEmail } from "../../emails/booking/TrialAndSubscriptionEmail";

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
    payment: [{ id: "pay-1" }],
    subscription: {
      id: "sub-1",
      status: "APPROVED",
      sessionsTotal: 12,
      sessionsRefunded: 0,
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
      // The plan's advisory lock, taken before the sessions are read.
      $executeRaw: jest.fn().mockResolvedValue(1),
      appointment: {
        findUnique: jest.fn().mockResolvedValue(wrapperWith(statuses)),
      },
      // #1766 (PR-Z2) — the money half runs first; the bell is what this
      // suite pins, so the stamp is a counted no-op here.
      consultantEarnings: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
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

// The notice can fire mid-week (a session of that week not yet placed), so
// neither the bell nor the email claims a week is done.
it("words the cycle-done notice without a week claim", () => {
  const bell = B2C_TEMPLATES.find(
    (t) => t.workflowId === NOVU_WORKFLOWS.SUBSCRIPTION_RENEWED,
  );
  expect(bell?.inApp.body).toContain(
    "Your latest {{payload.planTitle}} sessions are done",
  );
  expect(bell?.inApp.body).not.toMatch(/Week/);

  const html = renderToStaticMarkup(
    React.createElement(TrialAndSubscriptionEmail, {
      kind: "SUBSCRIPTION_RENEWED",
      planTitle: "Intensive",
      consultantName: "Asha",
      nextBatch: 2,
      remainingSessions: 6,
      dashboardUrl: "https://example.test/dashboard",
    }),
  );
  expect(html).toContain(
    "Your latest sessions of <strong>Intensive</strong> are complete",
  );
  expect(html).not.toMatch(/Week \d/);
});
