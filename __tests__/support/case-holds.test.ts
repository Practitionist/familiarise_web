/** @jest-environment node */
jest.mock("../../lib/payments/payouts/clawback-recovery", () => ({
  releaseClawbackRecovery: jest.fn(async () => undefined),
}));

import { EarningsHoldReason, type EarningStatus } from "@prisma/client";

import { createEarningsHoldStore } from "../fixtures/earnings-hold-store";
import { OpsRefusal } from "../../lib/backoffice/ops-refusal-error";
import type { Tx } from "../../lib/prisma";
import {
  applyCaseHoldsToNewEarnings,
  holdPaymentForCase,
  releaseAllCaseHolds,
} from "../../lib/support/case-holds";

type Payout = { id: string; status: string };
type Earning = {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preHoldStatus?: EarningStatus | null;
  holdUntil?: Date | null;
  payoutId?: string | null;
  orgPayoutId?: string | null;
  payout?: Payout | null;
  orgPayout?: Payout | null;
};

function world() {
  const store = createEarningsHoldStore<Earning, Earning>();
  const payouts = new Map<string, Payout>();
  const events: Record<string, unknown>[] = [];
  const openCases: { id: string }[] = [{ id: "case-1" }];
  const payoutTable = {
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: { in: string[] } };
        data: { status: string };
      }) => {
        const payout = payouts.get(where.id);
        if (!payout || !where.status.in.includes(payout.status))
          return { count: 0 };
        payout.status = data.status;
        return { count: 1 };
      },
    ),
  };
  const withFindFirst = (table: typeof store.db.consultantEarnings) => ({
    ...table,
    findFirst: jest.fn(
      async (args: { where?: Record<string, unknown> }) =>
        (await table.findMany(args))[0] ?? null,
    ),
  });
  // The fixture matches flat columns; attach each hold's earning so the
  // relation filters `consultantEarnings: { paymentId }` resolve.
  const earningsHold = {
    ...store.db.earningsHold,
    findMany: jest.fn(async (args: Record<string, never> = {}) => {
      for (const hold of store.holds) {
        Object.assign(hold, {
          consultantEarnings: store.consultant.find(
            (e) => e.id === hold.consultantEarningsId,
          ),
          organizationEarnings: store.org.find(
            (e) => e.id === hold.organizationEarningsId,
          ),
        });
      }
      return store.db.earningsHold.findMany(args);
    }),
  };
  const tx = {
    consultantEarnings: withFindFirst(store.db.consultantEarnings),
    organizationEarnings: withFindFirst(store.db.organizationEarnings),
    earningsHold,
    consultantPayout: payoutTable,
    organizationPayout: payoutTable,
    supportCase: { findMany: jest.fn(async () => openCases) },
    supportCaseEvent: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { caseId: { in: string[] }; toValue?: string };
        }) =>
          events
            .filter(
              (e) =>
                where.caseId.in.includes(e.caseId as string) &&
                (where.toValue === undefined || e.toValue === where.toValue),
            )
            .reverse(),
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
  };
  const payout = (id: string, status: string) => {
    const row = { id, status };
    payouts.set(id, row);
    return row;
  };
  return {
    store,
    tx: tx as unknown as Tx,
    raw: tx,
    payout,
    events,
    openCases,
  };
}

const applied = (caseId: string, paymentId: string) => ({
  caseId,
  kind: "HOLD_APPLIED",
  toValue: paymentId,
  note: "Investigating a no-show",
  id: `evt-${caseId}-${paymentId}`,
  createdAt: new Date("2026-10-20T10:00:00Z"),
});

it("holds the payment's unpaid earnings, pulling one out of a payout not yet sent", async () => {
  const { store, tx, payout } = world();
  const approved = payout("po-1", "APPROVED");
  store.consultant.push(
    { id: "ce-ready", paymentId: "pay-1", status: "READY" },
    {
      id: "ce-batched",
      paymentId: "pay-1",
      status: "BATCHED",
      payoutId: "po-1",
      payout: approved,
    },
    {
      id: "ce-other",
      paymentId: "pay-2",
      status: "BATCHED",
      payoutId: "po-1",
      payout: approved,
    },
    { id: "ce-paid", paymentId: "pay-1", status: "PAID" },
  );
  store.org.push({ id: "oe-1", paymentId: "pay-1", status: "PENDING" });

  const held = await holdPaymentForCase(tx, {
    caseId: "case-1",
    paymentId: "pay-1",
    note: "Investigating a no-show",
  });

  expect(held.cancelledPayoutIds).toEqual(["po-1"]);
  expect(approved.status).toBe("CANCELLED");
  expect(held.consultantEarningIds.sort()).toEqual(["ce-batched", "ce-ready"]);
  expect(held.orgEarningIds).toEqual(["oe-1"]);
  for (const id of ["ce-ready", "ce-batched", "oe-1"])
    expect(store.activeReasons(id)).toEqual([EarningsHoldReason.SUPPORT_CASE]);
  expect(store.consultant.find((e) => e.id === "ce-ready")?.status).toBe(
    "HELD",
  );
  expect(store.consultant.find((e) => e.id === "ce-other")?.status).toBe(
    "READY",
  );
  expect(store.consultant.find((e) => e.id === "ce-paid")?.status).toBe("PAID");
  expect(store.holds.every((h) => h.sourceRef === "case-1")).toBe(true);
});

it("refuses while a linked payout is being sent", async () => {
  const { store, tx, payout } = world();
  store.consultant.push({
    id: "ce-1",
    paymentId: "pay-1",
    status: "BATCHED",
    payoutId: "po-1",
    payout: payout("po-1", "PROCESSING"),
  });
  await expect(
    holdPaymentForCase(tx, {
      caseId: "case-1",
      paymentId: "pay-1",
      note: "x",
    }),
  ).rejects.toBeInstanceOf(OpsRefusal);
  expect(store.holds).toHaveLength(0);
});

it("freezes earnings created later for a payment an open case still holds", async () => {
  const { store, tx, events } = world();
  events.push(applied("case-1", "pay-1"));
  store.consultant.push({
    id: "ce-new",
    paymentId: "pay-1",
    status: "PENDING",
  });
  store.org.push({ id: "oe-new", paymentId: "pay-1", status: "PENDING" });

  await applyCaseHoldsToNewEarnings(tx, {
    id: "pay-1",
    appointmentId: "appt-1",
  });

  expect(store.activeReasons("ce-new")).toEqual(["SUPPORT_CASE"]);
  expect(store.activeReasons("oe-new")).toEqual(["SUPPORT_CASE"]);
  expect(store.holds[0]).toMatchObject({
    sourceRef: "case-1",
    note: "Investigating a no-show",
  });
});

it("leaves new earnings alone once the case released its hold, or with no open case", async () => {
  const { store, tx, raw, events, openCases } = world();
  events.push(applied("case-1", "pay-1"), {
    caseId: "case-1",
    kind: "HOLD_RELEASED",
    toValue: "pay-1",
    createdAt: new Date("2026-10-20T11:00:00Z"),
  });
  store.consultant.push({
    id: "ce-new",
    paymentId: "pay-1",
    status: "PENDING",
  });
  await applyCaseHoldsToNewEarnings(tx, {
    id: "pay-1",
    appointmentId: "appt-1",
  });
  expect(store.holds).toHaveLength(0);

  openCases.length = 0;
  raw.supportCaseEvent.findMany.mockClear();
  await applyCaseHoldsToNewEarnings(tx, {
    id: "pay-1",
    appointmentId: "appt-1",
  });
  expect(raw.supportCaseEvent.findMany).not.toHaveBeenCalled();
});

it("releases every case hold, restoring status but never another owner's hold", async () => {
  const { store, tx, events } = world();
  store.consultant.push({ id: "ce-1", paymentId: "pay-1", status: "READY" });
  store.org.push({ id: "oe-1", paymentId: "pay-1", status: "PENDING" });
  await holdPaymentForCase(tx, {
    caseId: "case-1",
    paymentId: "pay-1",
    note: "x",
  });
  events.push(applied("case-1", "pay-1"));
  store.holds.push({
    id: "dispute-hold",
    consultantEarningsId: null,
    organizationEarningsId: "oe-1",
    reason: EarningsHoldReason.DISPUTE,
    sourceRef: "dispute-1",
    placedAt: new Date(),
    releasedAt: null,
    releasedById: null,
    note: null,
  });

  expect(
    await releaseAllCaseHolds(tx, {
      caseId: "case-1",
      actorId: "admin-1",
      note: "Released when the case was resolved",
    }),
  ).toBe(1);

  expect(store.consultant[0]).toMatchObject({ status: "READY" });
  expect(store.activeReasons("oe-1")).toEqual(["DISPUTE"]);
  expect(store.org[0]).toMatchObject({ status: "HELD" });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "HOLD_RELEASED",
      toValue: "pay-1",
      fromValue: "evt-case-1-pay-1",
    }),
  );
  expect(
    await releaseAllCaseHolds(tx, {
      caseId: "case-1",
      actorId: "admin-1",
      note: "again",
    }),
  ).toBe(0);
});

it("refuses when an earning stays batched in a payout it could not cancel", async () => {
  const { store, tx, payout } = world();
  store.consultant.push({
    id: "ce-1",
    paymentId: "pay-1",
    status: "BATCHED",
    payoutId: "po-1",
    payout: payout("po-1", "COMPLETED"),
  });
  await expect(
    holdPaymentForCase(tx, { caseId: "case-1", paymentId: "pay-1", note: "x" }),
  ).rejects.toMatchObject({ code: "PAYOUT_IN_FLIGHT" });
  expect(store.holds).toHaveLength(0);
});

it("maps an earning that keeps moving under the hold to EARNING_CHANGED", async () => {
  const { store, tx, raw } = world();
  store.consultant.push({ id: "ce-1", paymentId: "pay-1", status: "READY" });
  raw.consultantEarnings.updateMany.mockImplementation(async () => ({
    count: 0,
  }));
  await expect(
    holdPaymentForCase(tx, { caseId: "case-1", paymentId: "pay-1", note: "x" }),
  ).rejects.toMatchObject({ code: "EARNING_CHANGED" });
  expect(store.holds).toHaveLength(0);
});

it("places each earning's case hold once when the hold is applied again", async () => {
  const { store, tx } = world();
  store.consultant.push({ id: "ce-1", paymentId: "pay-1", status: "READY" });
  store.org.push({ id: "oe-1", paymentId: "pay-1", status: "PENDING" });
  const input = { caseId: "case-1", paymentId: "pay-1", note: "x" };
  await holdPaymentForCase(tx, input);
  await holdPaymentForCase(tx, input);
  expect(store.holds).toHaveLength(2);
  expect(store.activeReasons("ce-1")).toEqual(["SUPPORT_CASE"]);
  expect(store.consultant[0]).toMatchObject({
    status: "HELD",
    preHoldStatus: "READY",
  });
});
