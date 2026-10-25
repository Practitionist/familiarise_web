/**
 * @jest-environment node
 */

/**
 * The ledger audit's drift response: every drift run records an event and
 * pages once, and a drifting wallet has its spend frozen and pages fatal once.
 */

const captureException = jest.fn();
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
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
// The real freeze helper runs; a freeze is one WALLET_FREEZE SystemEvent insert.
const createFreezeEvent = jest.fn(async (_a: unknown) => ({}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemEvent: {
      findFirst: async () => null,
      create: (a: unknown) => createFreezeEvent(a),
    },
  },
}));

import {
  reportWalletDriftFreeze,
  respondToLedgerDrift,
} from "../../scripts/reconcile/ledger-drift-response";
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
    baselinedCount: 0,
    unbaselinedCount: findings.length,
    baselineExpiredCount: 0,
    baselineProblems: [],
  },
  findings,
});

const walletDrift: ReconcileReport["findings"][number] = {
  kind: "WALLET_BALANCE_DRIFT",
  billingAccountId: "ba_1",
  organizationId: "org_1",
  expectedPaise: 100,
  actualPaise: 90,
  deltaPaise: -10,
};
const seatDrift: ReconcileReport["findings"][number] = {
  kind: "ACTIVE_SEAT_COUNT_DRIFT",
  billingSubscriptionId: "sub_1",
  expectedPaise: 0,
  actualPaise: 0,
  deltaPaise: 0,
};

beforeEach(() => jest.clearAllMocks());

describe("respondToLedgerDrift", () => {
  it("records an event and pages once without freezing", async () => {
    await respondToLedgerDrift(report([walletDrift, seatDrift]));

    expect(recordSystemEvent).toHaveBeenCalledTimes(1);
    expect(createFreezeEvent).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe("reportWalletDriftFreeze", () => {
  it("pages fatal once for all wallet pages under the logical report identity", async () => {
    await reportWalletDriftFreeze(
      "rep_1",
      [walletDrift, seatDrift],
      [
        {
          billingAccountId: "ba_1",
          organizationId: "org_1",
          deltaPaise: -10,
          newlyFrozen: true,
        },
      ],
    );

    expect(createFreezeEvent).not.toHaveBeenCalled();
    expect(reportStandingFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "reconcile-ledgers:wallet-drift:rep_1",
        ids: ["rep_1"],
      }),
      expect.any(Function),
    );
    const levels = captureException.mock.calls.map((c) => c[1]?.level);
    expect(levels).toEqual(["fatal"]);
  });

  it("still pages when every freeze failed", async () => {
    await reportWalletDriftFreeze("rep_1", [walletDrift], []);
    expect(captureException.mock.calls.at(-1)?.[1]?.level).toBe("fatal");
  });

  it("includes partial freeze evidence in one alert", async () => {
    const second = { ...walletDrift, billingAccountId: "ba_2" };

    await reportWalletDriftFreeze(
      "rep_1",
      [walletDrift, second],
      [
        {
          billingAccountId: "ba_2",
          organizationId: "org_1",
          deltaPaise: -10,
          newlyFrozen: true,
        },
      ],
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[1]?.contexts.wallet).toMatchObject({
      driftingWallets: 2,
      frozenWallets: 1,
    });
  });

  it("does not freeze or page for non-wallet drift", async () => {
    await reportWalletDriftFreeze(
      "rep_1",
      [
        {
          kind: "SPLIT_SUM_MISMATCH",
          paymentId: "p1",
          expectedPaise: 1,
          actualPaise: 2,
          deltaPaise: 1,
        },
      ],
      [],
    );

    expect(createFreezeEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
