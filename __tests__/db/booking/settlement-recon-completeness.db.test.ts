/**
 * Settlement reconciliation on real Postgres: report lines are stored once, a
 * settlement journal is posted only when its stored lines add up to the
 * settlement entity's amount, and a line left unresolved is matched again in
 * place. The gateway is a fake report keyed by IST day.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

/** Report pages by `YYYY-M-D`, and settlement entity amounts by id. */
const mockPagesByDay = new Map<string, unknown[]>();
const mockSettlements = new Map<string, number>();
jest.mock("../../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => ({
    settlements: {
      reports: async (q: { year: number; month: number; day: number }) => ({
        items: mockPagesByDay.get(`${q.year}-${q.month}-${q.day}`) ?? [],
      }),
      fetch: async (id: string) => {
        const amount = mockSettlements.get(id);
        if (amount === undefined) throw new Error("unknown settlement");
        return { id, entity: "settlement", amount };
      },
    },
  }),
  withRazorpaySdkTimeout: (_op: string, fn: () => Promise<unknown>) => fn(),
}));

import { runReconcileGatewaySettlements } from "../../../jobs/reconcile/reconcile-gateway-settlements";

// 2026-10-20 08:00 IST; the report day under test is 2026-10-19 IST.
const NOW = new Date("2026-10-20T02:30:00Z");
const DAY = "2026-10-19";
const SETTLED_AT = Math.floor(Date.parse(`${DAY}T10:00:00+05:30`) / 1000);
const run = () =>
  runReconcileGatewaySettlements(Date.now(), NOW, { date: DAY });

const transfer = (settlementId: string, creditPaise: number) => ({
  entity_id: `trf_dbtier_${randomUUID()}`,
  type: "transfer",
  amount: creditPaise,
  credit: creditPaise,
  debit: 0,
  settlement_id: settlementId,
  settled_at: SETTLED_AT,
});

const journalOf = (settlementId: string) =>
  prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `settlement:${settlementId}` },
    select: {
      kind: true,
      entries: {
        select: {
          direction: true,
          amountPaise: true,
          account: { select: { kind: true } },
        },
      },
    },
  });

beforeEach(() => {
  mockPagesByDay.clear();
  mockSettlements.clear();
});

it("posts a settlement journal only when its stored lines add up to the settlement amount", async () => {
  const whole = `setl_dbtier_${randomUUID()}`;
  const partial = `setl_dbtier_${randomUUID()}`;
  const first = transfer(partial, 60_000);
  mockPagesByDay.set("2026-10-19", [
    transfer(whole, 30_000),
    transfer(whole, 20_000),
    first,
    // Rejected one at a time: a fractional amount and an empty type.
    { ...transfer(whole, 1), amount: 10.5 },
    { ...transfer(whole, 1), type: "" },
  ]);
  mockSettlements.set(whole, 50_000);
  mockSettlements.set(partial, 100_000);

  const held = await run();

  expect(held).toMatchObject({ inserted: 3, rejectedRows: 2 });
  expect(held.settlementsHeld).toBeGreaterThanOrEqual(1);
  expect(await journalOf(partial)).toBeNull();
  const posted = await journalOf(whole);
  expect(posted?.kind).toBe("GATEWAY_SETTLEMENT");
  expect(
    posted?.entries
      .map((e) => [e.direction, e.account.kind, Number(e.amountPaise)])
      .sort(),
  ).toEqual([
    ["CREDIT", "GATEWAY_CLEARING", 50_000],
    ["DEBIT", "CASH", 50_000],
  ]);

  // The same day read again with the missing line: stored once, booked once.
  mockPagesByDay.set("2026-10-19", [first, transfer(partial, 40_000)]);
  const booked = await run();
  await run();

  expect(booked.inserted).toBe(1);
  const late = await journalOf(partial);
  expect(late?.entries.map((e) => Number(e.amountPaise))).toEqual([
    100_000, 100_000,
  ]);
  expect(
    await prisma.gatewaySettlementLine.count({
      where: { settlementId: partial },
    }),
  ).toBe(2);
});

it("matches an unresolved refund line again, in place, once the refund is on the books", async () => {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const startsAt = futureAt(5, 9);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null, amount: 50_000 },
    },
  );
  const gatewayRefundId = `rfnd_dbtier_${randomUUID()}`;
  mockPagesByDay.set("2026-10-19", [
    {
      entity_id: gatewayRefundId,
      type: "refund",
      amount: 20_000,
      debit: 20_000,
      credit: 0,
      settlement_id: `setl_dbtier_${randomUUID()}`,
      settled_at: SETTLED_AT,
    },
  ]);
  const line = () =>
    prisma.gatewaySettlementLine.findFirstOrThrow({
      where: { entityId: gatewayRefundId, type: "refund" },
      select: { id: true, status: true, matchedKind: true, matchedId: true },
    });

  await run();
  const before = await line();
  expect(before).toMatchObject({ status: "UNMATCHED", matchedId: null });

  const refund = await prisma.refund.create({
    data: {
      paymentId: booking.payment!.id,
      amountPaise: BigInt(20_000),
      status: "SUCCEEDED",
      refundId: gatewayRefundId,
      paymentGateway: "RAZORPAY",
    },
  });
  const rerun = await run();

  expect(rerun.rematched).toBeGreaterThanOrEqual(1);
  expect(await line()).toEqual({
    id: before.id,
    status: "MATCHED",
    matchedKind: "REFUND",
    matchedId: refund.id,
  });
});
