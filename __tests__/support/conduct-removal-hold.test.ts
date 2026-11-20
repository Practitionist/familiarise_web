/**
 * @jest-environment node
 */

/**
 * A conduct removal holds the seat's earnings once per case: a free seat holds
 * nothing, and a removal that joins a case already holding the payment logs no second hold.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
const mockHold = jest.fn(async (..._args: unknown[]) => ({
  consultantEarningIds: ["earning-1"],
  orgEarningIds: [],
  cancelledPayoutIds: [],
}));
jest.mock("../../lib/support/case-holds", () => ({
  ...jest.requireActual("../../lib/support/case-holds"),
  holdPaymentForCase: (...args: unknown[]) => mockHold(...args),
}));

import type { Tx } from "@/lib/prisma";
import { holdSeatEarningsTx } from "@/lib/support/conduct-removal-case";

const NOW = new Date("2026-11-19T10:00:00.000Z");

function txFor(opts: {
  payment: { amount: number; originalAmount: number; paymentIntent: string };
  holdEvents: { kind: "HOLD_APPLIED" | "HOLD_RELEASED" }[];
}) {
  const events: unknown[] = [];
  const tx = {
    payment: {
      findFirst: async () => ({
        id: "pay-1",
        refundOwedKey: null,
        ...opts.payment,
      }),
    },
    supportCaseEvent: {
      findMany: async () =>
        opts.holdEvents.map((e, i) => ({
          id: `ev-${i}`,
          caseId: "case-1",
          kind: e.kind,
          toValue: "pay-1",
          note: null,
          createdAt: NOW,
        })),
      create: async (args: { data: unknown }) => {
        events.push(args.data);
        return {};
      },
    },
  } as unknown as Tx;
  return { tx, events };
}

const hold = (tx: Tx) =>
  holdSeatEarningsTx(tx, {
    appointmentId: "appt-1",
    userId: "learner-1",
    caseId: "case-1",
    now: NOW,
  });
const PAID = {
  amount: 100_000,
  originalAmount: 100_000,
  paymentIntent: "order_1",
};

beforeEach(() => mockHold.mockClear());

it("holds a paid seat's earnings and logs the hold once", async () => {
  const { tx, events } = txFor({ payment: PAID, holdEvents: [] });
  await expect(hold(tx)).resolves.toBe(true);
  expect(mockHold).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    expect.objectContaining({ kind: "HOLD_APPLIED", toValue: "pay-1" }),
  ]);
});

it("a removal joining a case that already holds the payment logs no second hold", async () => {
  const { tx, events } = txFor({
    payment: PAID,
    holdEvents: [{ kind: "HOLD_APPLIED" }],
  });
  await expect(hold(tx)).resolves.toBe(true);
  expect(events).toEqual([]);
});

it("a free seat has no earnings to hold, so nothing is held or logged", async () => {
  const { tx, events } = txFor({
    payment: { amount: 0, originalAmount: 0, paymentIntent: "free_1" },
    holdEvents: [],
  });
  await expect(hold(tx)).resolves.toBe(false);
  expect(mockHold).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});
