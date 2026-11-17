/**
 * @jest-environment node
 */

const calls: Record<string, unknown[]> = {};
function mockFindMany(model: string, rows: () => unknown[]) {
  return jest.fn(async (args: unknown) => {
    calls[model] = [...(calls[model] ?? []), args];
    return rows();
  });
}
const mockAt = new Date("2026-10-01T10:00:00Z");
const mockRefundRow = (i: number) => ({
  id: `r${i}`,
  amountPaise: 100,
  currency: "INR",
  status: "SUCCEEDED",
  reason: null,
  refundId: `rfnd_${i}`,
  failureReason: null,
  failedAt: null,
  cascadedAt: null,
  deletedAt: null,
  createdAt: mockAt,
  updatedAt: mockAt,
});

const mockPayment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  amount: 50000,
  currency: "INR",
  paymentStatus: "SUCCEEDED",
  paymentGateway: "RAZORPAY",
  paymentIntent: `order_${id}`,
  gatewayPaymentId: `rzp_${id}`,
  userId: "user_1",
  appointmentId: null,
  organizationId: null,
  hostOrganizationId: null,
  billableToOrgInvoiceId: null,
  parentPaymentId: null,
  refundOwedPaise: null,
  refundOwedReason: null,
  refundOwedAt: null,
  capturedAt: mockAt,
  lastReconciledAt: null,
  deletedAt: null,
  createdAt: mockAt,
  updatedAt: mockAt,
  user: { name: "Asha" },
  ...over,
});
let mockRoot: Record<string, unknown> = {};
let mockChildren: unknown[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: jest.fn(async () => ({
        ...mockPayment("pay_1", mockRoot),
        childPayments: mockChildren,
      })),
    },
    paymentLeg: { findMany: mockFindMany("paymentLeg", () => []) },
    refund: {
      findMany: mockFindMany("refund", () =>
        Array.from({ length: 51 }, (_, i) => mockRefundRow(i)),
      ),
    },
    dispute: {
      findMany: jest.fn(async () => {
        throw new Error("boom");
      }),
    },
    ledgerTransaction: {
      findMany: mockFindMany("ledgerTransaction", () => []),
    },
    consultantEarnings: {
      findMany: mockFindMany("consultantEarnings", () => []),
    },
    consumerInvoice: { findMany: mockFindMany("consumerInvoice", () => []) },
    supportCase: { findMany: mockFindMany("supportCase", () => []) },
    opsActionLog: { findMany: mockFindMany("opsActionLog", () => []) },
    systemEvent: { findMany: mockFindMany("systemEvent", () => []) },
  },
}));

const mockRequirePage = jest.fn();
jest.mock("@/lib/auth-guard", () => ({
  requireBackofficePage: (...a: unknown[]) => mockRequirePage(...a),
}));
jest.mock("@/components/dashboard/backoffice/EntityTraceView", () => ({
  EntityTraceView: () => null,
}));

import TracePage from "@/app/dashboard/(backoffice)/[tree]/trace/page";
import {
  bookingStepLabel,
  enumWords,
  mergeTimeline,
  readEntityTrace,
  TRACE_PAYMENT_CAP,
  TRACE_ROW_CAP,
} from "@/lib/backoffice/entity-trace";
import type { TraceRow } from "@/lib/backoffice/entity-trace-types";

const row = (over: Partial<TraceRow>): TraceRow => ({
  key: "k",
  at: "2026-10-01T10:00:00.000Z",
  source: "payment",
  status: "s",
  amountPaise: null,
  currency: null,
  actor: null,
  detail: null,
  entityId: "e",
  sentryHref: null,
  ...over,
});

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  mockRoot = {};
  mockChildren = [];
});

it("merges oldest first, breaks ties by source order then key, and drops duplicates and bad dates", () => {
  const merged = mergeTimeline([
    row({ key: "b", at: "2026-10-02T00:00:00.000Z" }),
    row({ key: "refund", source: "refund" }),
    row({ key: "pay", source: "payment" }),
    row({ key: "pay", source: "payment", status: "duplicate" }),
    row({ key: "bad", at: "not a date" }),
  ]);
  expect(merged.map((r) => r.key)).toEqual(["pay", "refund", "b"]);
  expect(merged[0].status).toBe("s");
});

it("caps every source, reports the cut and a failure, and scopes staff reads", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const trace = await readEntityTrace({
    kind: "payment",
    id: "pay_1",
    viewer: { userId: "staff_1", role: "STAFF", seesSystemEvents: false },
  });
  for (const model of [
    "paymentLeg",
    "refund",
    "ledgerTransaction",
    "consultantEarnings",
    "consumerInvoice",
    "opsActionLog",
  ]) {
    expect(calls[model]?.[0]).toMatchObject({ take: TRACE_ROW_CAP + 1 });
  }
  expect(calls.supportCase?.[0]).toMatchObject({ take: 11 });
  expect(calls.opsActionLog?.[0]).toMatchObject({
    where: { actorUserId: "staff_1" },
  });
  expect(calls.systemEvent).toBeUndefined();
  const report = (s: string) => trace?.sources.find((r) => r.source === s);
  expect(report("refund")).toMatchObject({ truncated: true, rows: 100 });
  expect(report("dispute")).toMatchObject({ failed: true });
  expect(trace?.rows.length).toBeGreaterThan(100);
});

it("reports the payment source as cut past the child-payment cap and keeps a zero amount", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  mockRoot = { refundOwedPaise: 0, refundOwedAt: mockAt };
  mockChildren = Array.from({ length: TRACE_PAYMENT_CAP + 1 }, (_, i) =>
    mockPayment(`child_${i}`, { parentPaymentId: "pay_1" }),
  );
  const trace = await readEntityTrace({
    kind: "payment",
    id: "pay_1",
    viewer: { userId: "admin_1", role: "ADMIN", seesSystemEvents: false },
  });
  const report = trace?.sources.find((r) => r.source === "payment");
  expect(report?.truncated).toBe(true);
  const ids = new Set(
    trace?.rows.filter((r) => r.source === "payment").map((r) => r.entityId),
  );
  expect(ids.size).toBe(TRACE_PAYMENT_CAP + 1);
  expect(
    trace?.rows.find((r) => r.key === "payment:pay_1:refund-owed")?.amountPaise,
  ).toBe(0);
});

it("gates the page on the Payments tab's surface", async () => {
  mockRequirePage.mockResolvedValue({
    session: { user: { id: "staff_1" } },
    cap: { role: "STAFF", audience: "STAFF" },
  });
  await TracePage({
    params: Promise.resolve({ tree: "staff" }),
    searchParams: Promise.resolve({}),
  });
  expect(mockRequirePage).toHaveBeenCalledWith("payments.read", "staff");
});

it("names booking steps and statuses in words, not enum names", () => {
  expect(
    bookingStepLabel("RESCHEDULE_REQUEST", "PENDING_REVIEW", "DECLINED"),
  ).toBe("Reschedule request: pending review → declined");
  expect(bookingStepLabel("CONSULTATION", null, "CREATED")).toBe(
    "Consultation: created",
  );
  // Acronyms keep their capitals inside a sentence.
  expect(enumWords("UPI_COLLECT")).toBe("UPI collect");
});
