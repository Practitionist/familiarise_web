import { WalletReason } from "@prisma/client";
import {
  WALLET_REASON_LABEL,
  disputeReasonText,
  disputeStatusLabel,
  walletReasonLabel,
} from "@/lib/labels/money-labels";
import { payoutNoticeReason } from "@/lib/dashboard/earnings-state";

describe("money label maps", () => {
  it("names every wallet reason in words, never the enum", () => {
    for (const reason of Object.values(WalletReason)) {
      expect(WALLET_REASON_LABEL[reason]).toBeTruthy();
      expect(walletReasonLabel(reason)).not.toBe(reason);
    }
    expect(walletReasonLabel("TOPUP")).toBe("Top-up");
  });

  it("reads gateway dispute codes as words and passes prose through", () => {
    expect(disputeReasonText("product_not_received")).toBe(
      "Goods never arrived",
    );
    expect(disputeReasonText("some_new_code")).toBe("Some new code");
    expect(disputeReasonText("Chargeback")).toBe("Chargeback");
    expect(disputeReasonText("Customer says the class never ran")).toBe(
      "Customer says the class never ran",
    );
    expect(disputeStatusLabel("WARNING_NEEDS_RESPONSE")).not.toMatch(/_/);
  });

  it("gives a payout notice plain words, never gateway text or ids", () => {
    expect(payoutNoticeReason("REVERSED", "pout_ABC reversed")).toBe(
      "the amount is back in your balance",
    );
    expect(payoutNoticeReason("FAILED", "RazorpayX failure pout_XYZ")).toBe(
      "we couldn't send this payout",
    );
    expect(payoutNoticeReason("FAILED", "invalid_account_number")).toBe(
      "your bank details did not match",
    );
  });
});
