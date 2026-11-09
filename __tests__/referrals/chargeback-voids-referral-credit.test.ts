/**
 * @jest-environment node
 */

/**
 * A lost chargeback voids the referral rewards its payment vested, inside the
 * settlement's own transaction: `settleLostDispute` hands its `tx` to
 * `voidVestedReferralRewards`, never the global client.
 */

const mockVoidVestedReferralRewards = jest.fn();
jest.mock("../../lib/referrals/credit-reversal", () => ({
  voidVestedReferralRewards: (...a: unknown[]) =>
    mockVoidVestedReferralRewards(...a),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: jest.fn(),
  recordSystemEvent: jest.fn(),
  recordSystemErrorSafe: jest.fn(),
  recordSystemEventSafe: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => ({ payments: { fetch: async () => ({}) } }),
}));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
  walletCredit: jest.fn(),
  walletDebit: jest.fn(),
  WalletInsufficientFundsError: class extends Error {},
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: jest.fn(),
  consultantClawbackKey: jest.fn(),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn(),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn().mockResolvedValue({ creditNoteId: null }),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest
    .fn()
    .mockResolvedValue({ consumerCreditNoteId: null }),
  mintConsumerInvoice: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import prisma, { type Tx } from "../../lib/prisma";
import { settleLostDispute } from "../../app/api/webhooks/utils";

// A card-funded payment with no earnings and an already-posted chargeback journal,
// so only the referral void is left to observe.
const txStub = {
  paymentLeg: { count: jest.fn().mockResolvedValue(0) },
  consultantEarnings: { findMany: jest.fn().mockResolvedValue([]) },
  organizationEarnings: { findMany: jest.fn().mockResolvedValue([]) },
  payment: {
    findUnique: jest.fn().mockResolvedValue({
      id: "pay_1",
      organizationId: null,
      billingAccountId: null,
      amount: 10_000,
      paymentIntent: "order_1",
      appointmentId: "appt_1",
    }),
  },
  ledgerTransaction: { findUnique: jest.fn().mockResolvedValue({ id: "lt" }) },
};
const tx = txStub as unknown as Tx;

const dispute = {
  id: "dsp_row_1",
  disputeId: "disp_rzp_1",
  amountPaise: 10_000,
  paymentId: "pay_1",
  payment: { amount: 10_000 },
};

beforeEach(() => {
  mockVoidVestedReferralRewards
    .mockReset()
    .mockResolvedValue({ reversedPaise: 0, waiversRevoked: 0 });
});

it("voids the payment's vested referral rewards on the settlement tx", async () => {
  await settleLostDispute(tx, dispute, 10_000);

  expect(mockVoidVestedReferralRewards).toHaveBeenCalledTimes(1);
  const [client, input] = mockVoidVestedReferralRewards.mock.calls[0];
  expect(client).toBe(tx);
  expect(client).not.toBe(prisma);
  expect(input).toEqual({
    paymentId: "pay_1",
    disputeId: "disp_rzp_1",
    now: expect.any(Date),
  });
});

it("a failed void fails the settlement, so the tx rolls back", async () => {
  mockVoidVestedReferralRewards.mockRejectedValueOnce(
    new Error("REFERRAL_CREDIT_CHANGED: credit c1"),
  );
  await expect(settleLostDispute(tx, dispute, 10_000)).rejects.toThrow(
    "REFERRAL_CREDIT_CHANGED",
  );
});

it("a zero-paise loss settles as a release and voids nothing", async () => {
  await settleLostDispute(tx, dispute, 0);
  expect(mockVoidVestedReferralRewards).not.toHaveBeenCalled();
});
