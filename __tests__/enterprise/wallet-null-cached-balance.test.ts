/**
 * @jest-environment node
 */

/**
 * #1459 — `BillingAccount.walletBalance` is nullable, and an INVOICE-funded
 * account is created without one. Postgres evaluates `NULL + amount` to `NULL`,
 * so `walletCredit`'s increment silently no-opped on exactly those accounts
 * while the ledger CREDIT posted: the cache and the journal disagreed forever,
 * and only the nightly reconciler noticed. The fake transaction below reproduces
 * that NULL arithmetic rather than JavaScript's, which is what makes the pin
 * meaningful — an `Int?` column that behaves like zero would have passed before
 * the fix too.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue(undefined),
}));

import { postLedgerTxn } from "../../lib/payments/ledger/post";
import { walletCredit } from "../../lib/api/organizations/wallet";

/** A billing account row whose cached balance obeys Postgres NULL arithmetic. */
function invoiceFundedAccount() {
  const row = {
    walletBalance: null as number | null,
    currency: "INR",
    ownerOrgId: "org_1",
  };
  return {
    row,
    tx: {
      billingAccount: {
        updateMany: jest.fn(
          async (args: {
            where: { walletBalance?: null };
            data: { walletBalance: number };
          }) => {
            // `walletBalance: null` in the WHERE matches only a row that still
            // has no cached balance, exactly like the SQL `IS NULL`.
            if (args.where.walletBalance === null && row.walletBalance !== null)
              return { count: 0 };
            row.walletBalance = args.data.walletBalance;
            return { count: 1 };
          },
        ),
        update: jest.fn(
          async (args: { data: { walletBalance: { increment: number } } }) => {
            row.walletBalance =
              row.walletBalance === null
                ? null
                : row.walletBalance + args.data.walletBalance.increment;
            return { ...row };
          },
        ),
      },
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("walletCredit against a NULL cached balance (#1459)", () => {
  it("leaves the cache agreeing with the ledger CREDIT it posts", async () => {
    const { row, tx } = invoiceFundedAccount();

    const result = await walletCredit(tx as never, {
      billingAccountId: "ba_1",
      amountPaise: 123400,
      reason: "TOPUP",
      providerOrderId: "order_wave1c_001",
      providerPaymentId: "pay_wave1c_001",
    });

    expect(row.walletBalance).toBe(123400);
    expect(result.balanceAfter).toBe(123400);

    const posted = (postLedgerTxn as jest.Mock).mock.calls[0][1];
    expect(posted.postings).toContainEqual(
      expect.objectContaining({
        direction: "CREDIT",
        amountPaise: 123400,
        account: { kind: "WALLET", organizationId: "org_1" },
      }),
    );
  });
});
