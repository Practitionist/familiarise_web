/**
 * @jest-environment node
 */

// A broken template never aborts the money or moderation write it rides on:
// converted producers render before their transaction opens, and a render
// failure stages nothing (or a `review:render_failed` row) instead of throwing.

const mockEvents: string[] = [];
const mockRender = jest.fn();
const mockCreatedEmails: { data: Record<string, unknown> }[] = [];
const mockDb = {
  user: { findMany: jest.fn() },
  failedEmail: {
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      mockCreatedEmails.push(args);
      return { id: `fe_${mockCreatedEmails.length}` };
    }),
  },
  emailSuppression: { findUnique: jest.fn(async () => null) },
  organizationInvoice: { findMany: jest.fn(), updateMany: jest.fn() },
  orgAuditLog: { create: jest.fn(async () => ({})) },
  consultantReview: { findUnique: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    mockEvents.push("begin");
    const result = await run(mockDb);
    mockEvents.push("commit");
    return result;
  }),
};

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("@/lib/email/render", () => ({
  renderEmail: (...args: unknown[]) => {
    mockEvents.push("render");
    return mockRender(...args);
  },
}));
jest.mock("@/lib/email/deliver", () => ({
  ...jest.requireActual("@/lib/email/deliver"),
  attempt: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, run: () => unknown) => run(),
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (run: () => unknown) => run(),
}));
jest.mock("@/lib/feature-flags", () => ({ ENABLE_DUNNING_SUSPEND: false }));
jest.mock("@/lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: jest.fn(),
}));
jest.mock("@/lib/payments/billing/org-invoice-settlement", () => ({
  applyOrgInvoiceCapture: jest.fn(),
  invoiceOutstandingPaise: jest.fn(),
}));
jest.mock("@/lib/novu/org-workflows", () => ({
  notifyOrgInvoiceOverdue: jest.fn(async () => []),
  rosterForOrg: jest.fn(async () => ["owner-1"]),
  VISIBILITY_ROLES: ["OWNER"],
}));
jest.mock("@/lib/novu/outbox", () => ({ attemptTrigger: jest.fn() }));
jest.mock("@/lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("@/lib/novu", () => ({}));
jest.mock("@/lib/reviews", () => ({ recomputeConsultantRating: jest.fn() }));
jest.mock("@/lib/stream-client", () => ({}));

import * as Sentry from "@sentry/nextjs";
import { runDunning } from "@/jobs/billing/dunning";
import {
  prepareRefundProcessedEmail,
  stagePayoutStatusEmail,
  stageRefundProcessedEmail,
} from "@/lib/email/senders/money";
import {
  applyTransactionalEffects,
  prepareModerationNotices,
} from "@/lib/moderation/side-effects";
import { stagePaymentSuccessEmail } from "@/lib/payments/webhooks/staged-emails";

function user(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    timezone: "Asia/Kolkata",
    notificationPreferences: null,
  };
}

const boom = () => Promise.reject(new Error("template boom"));

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockCreatedEmails.length = 0;
  process.env.EMAIL_DELIVERY_MODE = "live";
  mockDb.user.findMany.mockResolvedValue([user("owner-1")]);
  mockRender.mockImplementation(boom);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const traceRows = () =>
  mockCreatedEmails
    .map((row) => row.data)
    .filter((data) => data.lastError === "review:render_failed");

it("dunning: the claim commits, the render ran before it opened, and the miss leaves a trace row", async () => {
  mockDb.organizationInvoice.findMany
    .mockResolvedValueOnce([
      {
        id: "inv-1",
        organizationId: "org-1",
        invoiceNumber: "INV-1",
        totalPaise: 100_000,
        displayCurrency: "INR",
        dueDate: new Date("2026-09-01T00:00:00Z"),
        organization: { name: "Org" },
      },
    ])
    .mockResolvedValueOnce([]);
  mockDb.organizationInvoice.updateMany.mockResolvedValue({ count: 1 });

  const stats = await runDunning({ limit: 5 });

  expect(stats).toMatchObject({ markedOverdue: 1, failed: 0 });
  expect(mockDb.organizationInvoice.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: "OVERDUE" }),
    }),
  );
  expect(mockEvents).toEqual(["render", "begin", "commit"]);
  expect(traceRows()).toEqual([
    expect.objectContaining({
      emailType: "ORG_INVOICE_OVERDUE",
      recipient: "owner-1@example.com",
      status: "DEAD_LETTER",
      htmlBody: "",
      entityRef: "orgInvoice:inv-1",
    }),
  ]);
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

it("refund receipt: staging a pre-rendered failure never renders in the transaction, never throws, and leaves a trace row", async () => {
  const args = {
    userId: "owner-1",
    paymentId: "pay-1",
    amountPaise: 50_000,
    currency: "INR",
  };
  const pre = await prepareRefundProcessedEmail(args);
  mockEvents.length = 0;

  await expect(
    mockDb.$transaction(() =>
      stageRefundProcessedEmail(mockDb as never, args, pre),
    ),
  ).resolves.toEqual([]);

  expect(mockEvents).toEqual(["begin", "commit"]);
  expect(traceRows()).toEqual([
    expect.objectContaining({
      emailType: "REFUND_PROCESSED",
      entityRef: "payment:pay-1",
    }),
  ]);
});

it("payment-success receipt: a render that failed before the capture stages its trace inside it", async () => {
  const payment = { id: "pay-2", user: { email: "buyer@example.com" } };

  await expect(
    stagePaymentSuccessEmail(
      mockDb as never,
      payment as never,
      {} as never,
      "CONSULTATION",
      null,
    ),
  ).resolves.toBeNull();

  expect(traceRows()).toEqual([
    expect.objectContaining({
      emailType: "PAYMENT_SUCCESS",
      recipient: "buyer@example.com",
      entityRef: "payment:pay-2",
    }),
  ]);
});

it("payout notice rendered inside the payout transaction: a throwing template stages nothing and does not throw", async () => {
  await expect(
    stagePayoutStatusEmail(mockDb as never, {
      userId: "owner-1",
      payoutId: "po-1",
      status: "COMPLETED",
      amountPaise: 10_000,
      currency: "INR",
    }),
  ).resolves.toEqual([]);
  expect(mockDb.failedEmail.create).not.toHaveBeenCalled();
});

it("moderation: the takedown commits with a broken template, rendered before the decision's transaction", async () => {
  mockDb.consultantReview.findUnique.mockResolvedValue({
    consultantProfileId: "cp-1",
    deletedAt: null,
    removedBy: null,
  });
  mockDb.consultantReview.updateMany.mockResolvedValue({ count: 1 });
  const input = {
    actionType: "CONTENT_REMOVED" as const,
    report: {
      id: "rep-1",
      type: "REVIEW" as const,
      reportedById: "owner-1",
      targetUserId: "owner-1",
      reviewId: "rev-1",
    },
    staffUserId: "staff-1",
  };

  const drafts = await prepareModerationNotices(input);
  const result = await mockDb.$transaction((tx) =>
    applyTransactionalEffects(tx as never, input, drafts),
  );

  expect(result).toMatchObject({ reviewRemoved: true });
  expect(mockDb.consultantReview.updateMany).toHaveBeenCalledTimes(1);
  expect(mockEvents).toEqual(["render", "render", "begin", "commit"]);
  expect(mockDb.failedEmail.create).not.toHaveBeenCalled();
});
