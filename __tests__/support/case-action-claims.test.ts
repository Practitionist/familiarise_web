/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: jest.fn(async () => null),
}));
jest.mock("../../lib/data/public-cache", () => ({
  purgeReviewSurfaces: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseDecision: { findUnique: jest.fn() },
    moderationAction: { findUnique: jest.fn() },
    supportCaseSubject: { findFirst: jest.fn() },
    supportCaseEvent: { create: jest.fn() },
    supportFinancialRecommendation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";
import {
  CaseActionError,
  performCaseAction,
} from "../../lib/support/case-actions";

const db = jest.mocked(prisma, { shallow: false });
const updatedAt = new Date("2026-10-20T10:00:00Z");
const admin = { userId: "admin-2", role: "ADMIN" as const };
const supportCase = {
  id: "case-1",
  referenceNumber: "FAM-2026-000001",
  title: "Refund help",
  organizationId: null,
  ownershipScope: "PERSONAL",
  requesterUserId: "customer",
  submitterUserId: "customer",
  appointmentId: "appt-1",
  externalRequesterEmail: null,
  appealOfDecisionId: null,
  appealOfModerationActionId: null,
  deletedAt: null,
  updatedAt,
};
const review = (approve: boolean) => ({
  action: "REVIEW_REFUND" as const,
  clientActionId: "review-1",
  expectedUpdatedAt: updatedAt.toISOString(),
  recommendationId: "rec-1",
  approve,
  reason: "Checked the session record",
});

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findFirst.mockResolvedValue(supportCase as never);
  db.supportCase.findUniqueOrThrow.mockResolvedValue(supportCase as never);
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCaseSubject.findFirst.mockResolvedValue(null);
  db.payment.findFirst.mockResolvedValue({
    id: "pay-1",
    amount: 500_000,
    paymentIntent: "pi_1",
    refunds: [],
    disputes: [],
  } as never);
});

it("refuses a refund review that loses the claim race to another administrator", async () => {
  db.supportFinancialRecommendation.findFirst.mockResolvedValueOnce({
    id: "rec-1",
    caseId: "case-1",
    paymentId: "pay-1",
    amountPaise: BigInt(100_000),
    decidedAt: null,
    approved: null,
    refund: null,
  } as never);
  db.supportFinancialRecommendation.updateMany.mockResolvedValue({ count: 0 });

  const outcome = performCaseAction("case-1", admin, review(false));

  await expect(outcome).rejects.toBeInstanceOf(CaseActionError);
  await expect(outcome).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.supportFinancialRecommendation.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "rec-1", decidedAt: null },
    }),
  );
  expect(refundBookingPayment).not.toHaveBeenCalled();
});

it("refuses an opposite decision on an already decided recommendation", async () => {
  db.supportFinancialRecommendation.findFirst.mockResolvedValueOnce({
    id: "rec-1",
    caseId: "case-1",
    decidedAt: updatedAt,
    approved: false,
  } as never);

  await expect(
    performCaseAction("case-1", admin, review(true)),
  ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  expect(db.supportFinancialRecommendation.updateMany).not.toHaveBeenCalled();
  expect(refundBookingPayment).not.toHaveBeenCalled();
});

it("refuses an appeal action by the operator who made the original decision", async () => {
  db.supportCase.findFirst.mockResolvedValue({
    ...supportCase,
    appealOfDecisionId: "decision-1",
  } as never);
  db.supportCaseDecision.findUnique.mockResolvedValue({
    decidedById: "admin-2",
  } as never);

  await expect(
    performCaseAction("case-1", admin, review(false)),
  ).rejects.toMatchObject({ code: "INDEPENDENT_REVIEW_REQUIRED", status: 403 });
  expect(db.supportCase.updateMany).not.toHaveBeenCalled();
});

it("refuses staff an admin-only money action", async () => {
  await expect(
    performCaseAction(
      "case-1",
      { userId: "staff-1", role: "STAFF" },
      {
        action: "VOID_RECOMMENDATION",
        clientActionId: "void-1",
        expectedUpdatedAt: updatedAt.toISOString(),
        recommendationId: "rec-1",
        reason: "Gateway refused the refund",
      },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(db.$transaction).not.toHaveBeenCalled();
});
