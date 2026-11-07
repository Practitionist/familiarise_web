/**
 * @jest-environment node
 */

/**
 * #1653 — the money senders. The refund webhook's staged twin reads and
 * stages through the transaction it is handed and never attempts; the org
 * wallet sender fans out to the roster it is given and the gate still applies.
 */

const mockDeliver = jest.fn();
const mockStage = jest.fn();
const mockAttempt = jest.fn();
const mockStageRenderFailure = jest.fn();
const mockGlobalFindMany = jest.fn();

jest.mock("../../lib/email/deliver", () => ({
  deliver: (...args: unknown[]) => mockDeliver(...args),
  stage: (...args: unknown[]) => mockStage(...args),
  attempt: (...args: unknown[]) => mockAttempt(...args),
  stageRenderFailure: (...args: unknown[]) => mockStageRenderFailure(...args),
}));

jest.mock("../../lib/email/render", () => ({
  renderEmail: jest.fn().mockResolvedValue({ html: "<p>hi</p>", text: "hi" }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockGlobalFindMany(...args) },
  },
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import {
  prepareOrgInvoiceOverdueEmail,
  sendOrgWalletLowEmail,
  stageOrgInvoiceOverdueEmail,
  stageRefundProcessedEmail,
} from "@/lib/email/senders/money";
import { renderEmail } from "@/lib/email/render";
import * as Sentry from "@sentry/nextjs";

function user(
  id: string,
  paymentNotifications = true,
  orgBillingAlerts = true,
) {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    timezone: "Asia/Kolkata",
    notificationPreferences: {
      allNotifications: true,
      emailEnabled: true,
      appointmentReminders: true,
      paymentNotifications,
      subscriptionAlerts: true,
      trialNotifications: true,
      supportUpdates: true,
      feedbackAlerts: true,
      orgBillingAlerts,
      orgMembershipAlerts: true,
      orgProgramAlerts: true,
    },
  };
}

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => {});
});

it("stageRefundProcessedEmail reads and stages through tx, and never attempts", async () => {
  const txFindMany = jest.fn().mockResolvedValue([user("payer_1")]);
  const tx = { user: { findMany: txFindMany }, failedEmail: {} };
  mockStage.mockResolvedValue({ id: "fe_1", idempotencyKey: "k" });

  const staged = await stageRefundProcessedEmail(tx as never, {
    userId: "payer_1",
    paymentId: "pay_1",
    amountPaise: BigInt(120000),
    currency: "INR",
  });

  expect(txFindMany).toHaveBeenCalledTimes(1);
  expect(mockGlobalFindMany).not.toHaveBeenCalled();
  expect(mockStage).toHaveBeenCalledTimes(1);
  expect(mockStage).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "payer_1@example.com",
      subject: "Your refund of ₹1,200.00 is on its way",
    }),
    "REFUND_PROCESSED",
    { tx, entityRef: "payment:pay_1" },
  );
  expect(mockAttempt).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
  expect(staged).toHaveLength(1);
});

it("sendOrgWalletLowEmail delivers once when one of two roster members opted out", async () => {
  mockGlobalFindMany.mockResolvedValue([
    user("owner_1"),
    user("manager_1", true, false),
  ]);
  mockDeliver.mockResolvedValue({ success: true, data: {} });

  const result = await sendOrgWalletLowEmail({
    recipientUserIds: ["owner_1", "manager_1"],
    organizationId: "org_1",
    orgName: "Acme",
    balancePaise: 90000,
    minimumPaise: 500000,
    currency: "INR",
    topUpUrl: "https://app.test/dashboard/organization/org_1/billing",
  });

  expect(result).toEqual({ sent: 1, skipped: 1, failed: 0 });
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  expect(mockDeliver).toHaveBeenCalledWith(
    expect.objectContaining({ to: "owner_1@example.com" }),
    "ORG_WALLET_LOW",
    { entityRef: "org:org_1", budgetMs: 10_000 },
  );
});

it("stageOrgInvoiceOverdueEmail stages through tx; a render failure stages a trace row instead of throwing or paging", async () => {
  const tx = {
    user: {
      findMany: jest.fn().mockResolvedValue([user("own_1"), user("own_2")]),
    },
    failedEmail: {},
  };
  mockStage.mockReset().mockResolvedValue({ id: "fe_1", idempotencyKey: "k" });
  const args = {
    recipientUserIds: ["own_1", "own_2"],
    invoiceId: "inv_1",
    invoiceNumber: "INV-1",
    orgName: "Acme",
    totalPaise: 100_000,
    currency: "INR",
    dueDate: new Date("2026-09-01T00:00:00Z"),
    daysLate: 3,
    reminderStage: 0,
    payUrl: "/dashboard/organization/org_1/billing",
  };

  await expect(
    stageOrgInvoiceOverdueEmail(tx as never, args),
  ).resolves.toHaveLength(2);
  expect(mockStage).toHaveBeenCalledWith(
    expect.objectContaining({ to: "own_1@example.com" }),
    "ORG_INVOICE_OVERDUE",
    { tx, entityRef: "orgInvoice:inv_1" },
  );

  mockStage.mockClear();
  jest.mocked(Sentry.captureException).mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.mocked(renderEmail).mockRejectedValueOnce(new Error("render boom"));
  await expect(
    stageOrgInvoiceOverdueEmail(tx as never, args),
  ).resolves.toHaveLength(1);
  expect(mockStage).toHaveBeenCalledTimes(1);
  expect(mockStageRenderFailure).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ to: "own_1@example.com" }),
    "ORG_INVOICE_OVERDUE",
    "orgInvoice:inv_1",
  );
  expect(Sentry.captureException).not.toHaveBeenCalled();

  // Rendered before the transaction: staging inside it reads and renders nothing.
  mockGlobalFindMany.mockResolvedValue([user("own_1"), user("own_2")]);
  const pre = await prepareOrgInvoiceOverdueEmail(args);
  jest.mocked(renderEmail).mockClear();
  tx.user.findMany.mockClear();
  mockStage.mockClear();
  await expect(
    stageOrgInvoiceOverdueEmail(tx as never, args, pre),
  ).resolves.toHaveLength(2);
  expect(renderEmail).not.toHaveBeenCalled();
  expect(tx.user.findMany).not.toHaveBeenCalled();
  expect(mockStage).toHaveBeenCalledTimes(2);
});
