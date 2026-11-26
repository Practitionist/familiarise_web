/** @jest-environment node */

/**
 * Stuck work lists a payment whose automatic refund gave up ("Auto-refund
 * stuck:"), beside parked captures, until a refund is pending or paid.
 */

const NOW = new Date("2026-11-23T10:00:00Z");
const HOUR = 3_600_000;
const STUCK =
  "Auto-refund stuck: capture landed after the seat was released. Booking NOT confirmed.";

/** A Prisma double whose missing model or method throws instead of reading as absent. */
function strict<T extends object>(name: string, impl: T): T {
  return new Proxy(impl, {
    get(target, key) {
      if (typeof key === "symbol" || key === "then" || key in target) {
        return Reflect.get(target, key);
      }
      throw new Error(`Prisma double has no ${name}.${String(key)}`);
    },
  });
}

type PaymentWhere = { description?: { startsWith?: string } };
const isStuckRead = (where: PaymentWhere) =>
  where.description?.startsWith === "Auto-refund stuck:";

/** The row the queue's payment `select` returns. */
const mockStuck = {
  id: "pay-stuck",
  description: STUCK,
  capturedAt: new Date(NOW.getTime() - 5 * HOUR),
  createdAt: new Date(NOW.getTime() - 6 * HOUR),
  _count: { refunds: 3 },
};

const mockEmpty = (name: string) =>
  strict(name, {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  });
const mockPaymentFindMany = jest.fn(async (args: { where: PaymentWhere }) =>
  isStuckRead(args.where) ? [mockStuck] : [],
);
const mockDb = strict("prisma", {
  payment: strict("payment", {
    findMany: mockPaymentFindMany,
    count: jest.fn(async () => 0),
  }),
  consultantPayout: mockEmpty("consultantPayout"),
  organizationPayout: mockEmpty("organizationPayout"),
  organizationInvoice: mockEmpty("organizationInvoice"),
  dispute: mockEmpty("dispute"),
  webhookEvent: mockEmpty("webhookEvent"),
  failedEmail: mockEmpty("failedEmail"),
  notificationOutbox: mockEmpty("notificationOutbox"),
  $queryRaw: jest.fn(async () => []),
});
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

import { readNeedsAttention } from "@/lib/backoffice/needs-attention";

it("lists a payment whose automatic refund gave up, with its attempts and the doors to refund it by hand", async () => {
  const queues = await readNeedsAttention(NOW);

  const queue = queues.find((q) => q.key === "stuckAutoRefunds");
  expect(queue).toMatchObject({
    label: "Automatic refunds that gave up",
    money: true,
    limitMs: 0,
  });
  expect(queue?.items).toEqual({
    total: 1,
    newest: [],
    oldest: [
      {
        id: "pay-stuck",
        state: "Refund by hand",
        ageMs: 5 * HOUR,
        attempts: 3,
        lastError: STUCK,
        links: [
          { label: "Payment", path: "payments/pay-stuck" },
          expect.objectContaining({
            path: expect.stringContaining("pay-stuck"),
          }),
          { label: "Refunds", path: "money/refunds" },
        ],
      },
    ],
  });
  // Listed until the money is on its way back: a pending or paid refund takes it off.
  const read = mockPaymentFindMany.mock.calls.find(([args]) =>
    isStuckRead(args.where),
  );
  expect(read?.[0].where).toEqual({
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
    description: { startsWith: "Auto-refund stuck:" },
    refunds: { none: { status: { in: ["PENDING", "SUCCEEDED"] } } },
  });
});
