/**
 * @jest-environment node
 */

/**
 * The ledger audit's drift response: every drift run records an event and
 * pages once, and a drifting wallet has its spend frozen.
 */

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));
const recordSystemEvent = jest.fn(async (_e: unknown) => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (e: unknown) => recordSystemEvent(e),
}));
const reportStandingFinding = jest.fn(
  async (_a: unknown, report: () => void) => {
    report();
    return true;
  },
);
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (a: unknown, r: () => void) =>
    reportStandingFinding(a, r),
}));
const freezeWalletSpend = jest.fn(async (_a: unknown) => true);
jest.mock("../../lib/payments/wallet-freeze", () => ({
  freezeWalletSpend: (a: unknown) => freezeWalletSpend(a),
}));

import { respondToLedgerDrift } from "../../scripts/reconcile/ledger-drift-response";
import type { ReconcileReport } from "../../scripts/reconcile/reconcile-ledgers";

const report = (findings: ReconcileReport["findings"]): ReconcileReport => ({
  id: "rep_1",
  runAt: new Date("2026-10-20T03:55:00Z"),
  scope: "full",
  ok: false,
  durationMs: 1,
  summary: {
    orgsChecked: 0,
    accountsChecked: 0,
    assignmentsChecked: 0,
    subscriptionsChecked: 0,
    paymentsChecked: 0,
    payoutsChecked: 0,
    earningsPaymentsWithoutBookingTxn: 0,
    discrepanciesCount: findings.length,
  },
  findings,
});

beforeEach(() => jest.clearAllMocks());

describe("respondToLedgerDrift", () => {
  it("freezes each drifting wallet and pages fatal once", async () => {
    await respondToLedgerDrift(
      report([
        {
          kind: "WALLET_BALANCE_DRIFT",
          billingAccountId: "ba_1",
          organizationId: "org_1",
          expectedPaise: 100,
          actualPaise: 90,
          deltaPaise: -10,
        },
        {
          kind: "ACTIVE_SEAT_COUNT_DRIFT",
          billingSubscriptionId: "sub_1",
          expectedPaise: 0,
          actualPaise: 0,
          deltaPaise: 0,
        },
      ]),
    );

    expect(recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(freezeWalletSpend).toHaveBeenCalledTimes(1);
    expect(freezeWalletSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        billingAccountId: "ba_1",
        organizationId: "org_1",
      }),
    );
    const levels = captureException.mock.calls.map((c) => c[1]?.level);
    expect(levels).toEqual([undefined, "fatal"]);
  });

  it("pages for the frozen wallets already done when a freeze throws", async () => {
    freezeWalletSpend.mockRejectedValueOnce(new Error("db down"));

    await expect(
      respondToLedgerDrift(
        report([
          {
            kind: "WALLET_BALANCE_DRIFT",
            billingAccountId: "ba_1",
            expectedPaise: 1,
            actualPaise: 2,
            deltaPaise: 1,
          },
        ]),
      ),
    ).rejects.toThrow("db down");
    expect(captureException.mock.calls.at(-1)?.[1]?.level).toBe("fatal");
  });

  it("does not freeze anything for non-wallet drift", async () => {
    await respondToLedgerDrift(
      report([
        {
          kind: "SPLIT_SUM_MISMATCH",
          paymentId: "p1",
          expectedPaise: 1,
          actualPaise: 2,
          deltaPaise: 1,
        },
      ]),
    );

    expect(freezeWalletSpend).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
