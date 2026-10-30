/**
 * @jest-environment node
 */

/**
 * An open partial-credit row stays on the Refunds queue however many newer,
 * already-answered rows exist: settled rows are dropped before any cut.
 */
type Event = {
  id: string;
  message: string;
  context: unknown;
  createdAt: Date;
  correlationId: string;
};

const base = new Date("2026-01-01T00:00:00Z").getTime();
const creditEvents: Event[] = [
  {
    id: "evt-open",
    message: "Credit seat pay-open needs a partial credit return",
    context: { paymentId: "pay-open" },
    createdAt: new Date(base),
    correlationId: "partial-credit:pay-open",
  },
  // 150 newer rows whose credit already came back.
  ...Array.from({ length: 150 }, (_, i) => ({
    id: `evt-${i}`,
    message: `Credit seat pay-${i} needs a partial credit return`,
    context: { paymentId: `pay-${i}` },
    createdAt: new Date(base + (i + 1) * 3_600_000),
    correlationId: `partial-credit:pay-${i}`,
  })),
];

/** The rows as Postgres would answer the query's order and cap. */
const answer = (args: {
  orderBy?: { createdAt: "asc" | "desc" };
  take?: number;
}) => {
  const sorted = [...creditEvents].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  if (args.orderBy?.createdAt === "desc") sorted.reverse();
  return args.take === undefined ? sorted : sorted.slice(0, args.take);
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemEvent: {
      findMany: async (args: {
        where: { OR?: unknown };
        orderBy?: { createdAt: "asc" | "desc" };
        take?: number;
      }) => (args.where.OR ? answer(args) : []),
    },
    refund: { findMany: async () => [] },
    referralCreditUsage: {
      findMany: async () => [{ paymentId: "pay-open", amount: 59_000 }],
    },
    payment: { findMany: async () => [] },
    supportFinancialRecommendation: { findMany: async () => [] },
  },
}));

import { readRefundNeedsHuman } from "@/lib/backoffice/needs-human";

it("keeps the oldest open credit row behind 150 newer settled ones", async () => {
  const items = await readRefundNeedsHuman();
  expect(items.map((i) => i.paymentId)).toEqual(["pay-open"]);
  expect(items[0]).toMatchObject({ kind: "credit", creditPlan: true });
});
