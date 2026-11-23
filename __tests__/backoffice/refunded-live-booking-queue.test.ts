/** @jest-environment node */

/**
 * Stuck work's queue of bookings still live after a refund made outside the app covered their
 * payment: each row names the buyer, the amount and the booking, says what to do next, and links
 * the booking's Ops actions, the payment and its trace. The selection itself is pinned on real
 * Postgres in `__tests__/db/booking/refunded-live-booking-visibility.db.test.ts`.
 */

const NOW = new Date("2026-11-23T10:00:00Z");
const MIN = 60_000;

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

/** The selection's rows, oldest refund first: one refunded wholly outside the app, one partly. */
const mockSelected = [
  {
    id: "pay-1to1",
    refundedAt: new Date(NOW.getTime() - 90 * MIN),
    outsidePaise: BigInt(50_000),
  },
  {
    id: "pay-seat",
    refundedAt: new Date(NOW.getTime() - 30 * MIN),
    outsidePaise: BigInt(70_000),
  },
];
const untitled = {
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
};
/** The rows the queue's payment `select` returns for them. */
const mockPayments = [
  {
    id: "pay-seat",
    amount: 120_000,
    appointmentId: "appt-webinar",
    user: { name: null },
    appointment: {
      ...untitled,
      id: "appt-webinar",
      appointmentType: "WEBINAR",
      webinar: { webinarPlan: { title: "Tax basics" } },
    },
  },
  {
    id: "pay-1to1",
    amount: 50_000,
    appointmentId: "appt-1to1",
    user: { name: "Asha Rao" },
    appointment: {
      ...untitled,
      id: "appt-1to1",
      appointmentType: "CONSULTATION",
      consultation: { consultationPlan: { title: "Career consult" } },
    },
  },
];

const mockEmpty = (name: string) =>
  strict(name, {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  });
const mockDb = strict("prisma", {
  payment: strict("payment", {
    findMany: jest.fn(async (args: { where: { id?: { in: string[] } } }) =>
      args.where.id
        ? mockPayments.filter((p) => args.where.id?.in.includes(p.id))
        : [],
    ),
    count: jest.fn(async () => 0),
  }),
  consultantPayout: mockEmpty("consultantPayout"),
  organizationPayout: mockEmpty("organizationPayout"),
  organizationInvoice: mockEmpty("organizationInvoice"),
  dispute: mockEmpty("dispute"),
  webhookEvent: mockEmpty("webhookEvent"),
  failedEmail: mockEmpty("failedEmail"),
  notificationOutbox: mockEmpty("notificationOutbox"),
  $queryRaw: jest.fn(async () => mockSelected),
});
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

import { readNeedsAttention } from "@/lib/backoffice/needs-attention";

it("says who was refunded what for which booking, how much outside the app, what to do, and links the booking's Ops actions", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const queues = await readNeedsAttention(NOW);
  expect(warn).not.toHaveBeenCalled();

  const queue = queues.find((q) => q.key === "refundedLiveBookings");
  expect(queue).toMatchObject({
    label: "Fully refunded, booking still live",
    money: true,
    limitMs: 0,
  });
  expect(queue?.items).toEqual({
    total: 2,
    newest: [],
    oldest: [
      {
        id: "pay-1to1",
        state:
          "Asha Rao was refunded ₹500.00 in full outside the app for Career consult, and the booking is still live. If it should end, cancel it from the booking's Ops actions; no further refund is due.",
        ageMs: 90 * MIN,
        attempts: null,
        lastError: null,
        links: [
          { label: "Booking", path: "appointments?open=appt-1to1" },
          { label: "Payment", path: "payments/pay-1to1" },
          { label: "Entity trace", path: "trace?kind=payment&id=pay-1to1" },
        ],
      },
      {
        id: "pay-seat",
        state:
          "A buyer was refunded ₹1,200.00 in full for Tax basics, ₹700.00 of it outside the app, and their seat is still confirmed. If the seat should end, ask the host to remove them; no further refund is due.",
        ageMs: 30 * MIN,
        attempts: null,
        lastError: null,
        links: [
          { label: "Booking", path: "appointments?open=appt-webinar" },
          { label: "Payment", path: "payments/pay-seat" },
          { label: "Entity trace", path: "trace?kind=payment&id=pay-seat" },
        ],
      },
    ],
  });
});
