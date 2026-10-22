/** Concurrent REVIEW_REFUND claims on one recommendation through performCaseAction on real Postgres. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";
import {
  CaseActionError,
  performCaseAction,
  type CaseActor,
} from "../../../lib/support/case-actions";
import {
  caseVersion,
  lockRecommendationRow,
  raceBehindLock,
  rowId,
  seedCase,
  seedUser,
  settledValues,
} from "../seed";

const PAYMENT_PAISE = 100_000;

/** A captured payment, a case on it, and a staff recommendation awaiting review. */
async function pendingRecommendation() {
  const customer = await seedUser();
  const proposer = await seedUser("STAFF");
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(PAYMENT_PAISE),
      originalAmount: BigInt(PAYMENT_PAISE),
      paymentMethod: "card",
      paymentIntent: `order_db_${randomUUID()}`,
      clientIdempotencyKey: randomUUID(),
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: customer.userId,
      // The payment-legs trigger needs the funding legs to sum to the amount.
      legs: { create: { source: "CARD", amountPaise: BigInt(PAYMENT_PAISE) } },
    },
  });
  const supportCase = await seedCase(customer.userId, {
    category: "PAYMENT_ISSUE",
    subjects: [
      { subjectType: "PAYMENT", subjectId: payment.id, isPrimary: true },
    ],
  });
  const recommendation = await performCaseAction(supportCase.id, proposer, {
    action: "RECOMMEND_REFUND",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await caseVersion(supportCase.id),
    paymentId: payment.id,
    amountPaise: 40_000,
    reason: "The session dropped halfway",
    releaseSeat: false,
  });
  return { caseId: supportCase.id, recommendationId: rowId(recommendation) };
}

function review(
  caseId: string,
  recommendationId: string,
  actor: CaseActor,
  approve: boolean,
) {
  return async () =>
    performCaseAction(caseId, actor, {
      action: "REVIEW_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      recommendationId,
      approve,
      reason: approve ? "Checked the session log" : "The session ran in full",
      ...(approve ? { expectedRefundablePaise: PAYMENT_PAISE } : {}),
    });
}

async function decidedEvents(caseId: string, recommendationId: string) {
  return prisma.supportCaseEvent.findMany({
    where: {
      caseId,
      kind: "RECOMMENDATION_DECIDED",
      toValue: recommendationId,
    },
  });
}

describe("concurrent refund reviews", () => {
  it("lets one approval claim the recommendation and refuses the other", async () => {
    const { caseId, recommendationId } = await pendingRecommendation();
    const [first, second] = [await seedUser("ADMIN"), await seedUser("ADMIN")];

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(lockRecommendationRow(recommendationId), [
        review(caseId, recommendationId, first, true),
        review(caseId, recommendationId, second, true),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(CaseActionError);
    expect(["CONFLICT", "ALREADY_DECIDED"]).toContain(
      (rejected[0] as CaseActionError).code,
    );
    const stored =
      await prisma.supportFinancialRecommendation.findUniqueOrThrow({
        where: { id: recommendationId },
      });
    expect(stored.approved).toBe(true);
    expect([first.userId, second.userId]).toContain(stored.decidedById);
    expect(
      (await decidedEvents(caseId, recommendationId)).map(
        (event) => event.note,
      ),
    ).toEqual(["APPROVED"]);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses the losing side when an approval and a decline race", async () => {
    const { caseId, recommendationId } = await pendingRecommendation();
    const [approver, decliner] = [
      await seedUser("ADMIN"),
      await seedUser("ADMIN"),
    ];

    const { fulfilled, rejected } = settledValues(
      await raceBehindLock(lockRecommendationRow(recommendationId), [
        review(caseId, recommendationId, approver, true),
        review(caseId, recommendationId, decliner, false),
      ]),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "ALREADY_DECIDED" });
    const stored =
      await prisma.supportFinancialRecommendation.findUniqueOrThrow({
        where: { id: recommendationId },
      });
    const approvedWon = stored.decidedById === approver.userId;
    expect(stored.approved).toBe(approvedWon);
    expect(
      (await decidedEvents(caseId, recommendationId)).map(
        (event) => event.note,
      ),
    ).toEqual([approvedWon ? "APPROVED" : "DECLINED"]);
    expect(refundBookingPayment).toHaveBeenCalledTimes(approvedWon ? 1 : 0);
  });
});
