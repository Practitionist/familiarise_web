/**
 * @jest-environment node
 */

/**
 * The payments and refunds lists answer an allowlist: a row the database hands
 * back whole still reaches the client without its payer hashes, metadata or
 * failure text. Paging is clamped, and each row names its buyer and booking.
 */

import { NextRequest } from "next/server";

import {
  paymentListPageSchema,
  refundListPageSchema,
} from "@/lib/backoffice/money-list-schemas";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "staff-1", role: "STAFF" } },
  }),
}));

const mockPaymentFindMany = jest.fn();
const mockRefundFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      count: async () => 41,
    },
    refund: {
      findMany: (...a: unknown[]) => mockRefundFindMany(...a),
      count: async () => 41,
    },
  },
}));

import { GET as paymentsGet } from "../../app/api/admin/payments/route";
import { GET as refundsGet } from "../../app/api/admin/refunds/route";

const PII = [
  "payerVpaHash",
  "payerPhoneHash",
  "metadata",
  "failureReason",
  "refundOwedReason",
  "clientIdempotencyKey",
];

const appointment = {
  id: "appt-1",
  appointmentType: "CLASS",
  consultation: null,
  subscription: null,
  webinar: null,
  class: { classPlan: { title: "Spoken Hindi, beginners" } },
  trial: null,
};
const user = {
  id: "user-1",
  name: "Priya Anderson",
  email: "priya@example.test",
};

/** A whole row, as a database that ignored the select would return it. */
const paymentRow = {
  id: "pay-1",
  amount: 150_000,
  currency: "INR",
  paymentIntent: "order_1",
  paymentGateway: "RAZORPAY",
  paymentStatus: "SUCCEEDED",
  isMockPayment: false,
  createdAt: new Date("2026-11-01T04:00:00Z"),
  payerVpaHash: "a".repeat(64),
  payerPhoneHash: "b".repeat(64),
  refundOwedReason: "owed",
  clientIdempotencyKey: "idem",
  user,
  appointment,
  consumerInvoice: null,
};
const refundRow = {
  id: "ref-1",
  refundId: "rfnd_1",
  amountPaise: 50_000,
  currency: "INR",
  status: "FAILED",
  reason: "HOST_CANCELLED_SESSION",
  paymentGateway: "RAZORPAY",
  createdAt: new Date("2026-11-02T04:00:00Z"),
  metadata: { gateway: "raw" },
  failureReason: "BAD_REQUEST_ERROR",
  payment: {
    id: "pay-1",
    paymentIntent: "order_1",
    payerVpaHash: "a".repeat(64),
    user,
    appointment,
  },
};

const keysDeep = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)])
    : [];

const call = (route: (r: NextRequest) => Promise<Response>, path: string) =>
  route(new NextRequest(`http://test${path}`));

beforeEach(() => {
  mockPaymentFindMany.mockReset().mockResolvedValue([paymentRow]);
  mockRefundFindMany.mockReset().mockResolvedValue([refundRow]);
});

describe("payments list", () => {
  it("names the buyer and the booking and sends no PII keys", async () => {
    const body = await (await call(paymentsGet, "/api/admin/payments")).json();
    expect(keysDeep(body).filter((k) => PII.includes(k))).toEqual([]);
    const page = paymentListPageSchema.parse(body);
    expect(page.payments[0].buyer?.name).toBe("Priya Anderson");
    expect(page.payments[0].booking).toEqual({
      id: "appt-1",
      type: "CLASS",
      title: "Spoken Hindi, beginners",
    });
    const select = mockPaymentFindMany.mock.calls[0][0].select;
    expect(Object.keys(select)).not.toEqual(expect.arrayContaining(PII));
    expect(mockPaymentFindMany.mock.calls[0][0].relationLoadStrategy).toBe(
      "join",
    );
  });

  it.each([
    ["?limit=500", 0, 100],
    ["?limit=abc&page=0", 0, 20],
    ["?page=3&limit=10", 20, 10],
  ])("clamps %s to skip %i take %i", async (query, skip, take) => {
    await call(paymentsGet, `/api/admin/payments${query}`);
    expect(mockPaymentFindMany.mock.calls[0][0]).toMatchObject({ skip, take });
  });

  it("answers 400 for a status that is not a payment status", async () => {
    const res = await call(paymentsGet, "/api/admin/payments?status=NOPE");
    expect(res.status).toBe(400);
    expect(mockPaymentFindMany).not.toHaveBeenCalled();
  });
});

describe("refunds list", () => {
  it("names the buyer and the booking and sends no metadata or failure text", async () => {
    const body = await (await call(refundsGet, "/api/admin/refunds")).json();
    expect(keysDeep(body).filter((k) => PII.includes(k))).toEqual([]);
    const page = refundListPageSchema.parse(body);
    expect(page.refunds[0].payment?.buyer?.email).toBe("priya@example.test");
    expect(page.refunds[0].payment?.booking?.title).toBe(
      "Spoken Hindi, beginners",
    );
    expect(page).toMatchObject({
      total: 41,
      page: 1,
      limit: 20,
      totalPages: 3,
    });
  });

  it("clamps the page size at 100", async () => {
    await call(refundsGet, "/api/admin/refunds?limit=1000&page=2");
    expect(mockRefundFindMany.mock.calls[0][0]).toMatchObject({
      skip: 100,
      take: 100,
    });
  });
});

it("a malformed body fails the list schema", () => {
  expect(
    paymentListPageSchema.safeParse({
      payments: [{ ...paymentRow, paymentStatus: "PAID" }],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    }).success,
  ).toBe(false);
});
