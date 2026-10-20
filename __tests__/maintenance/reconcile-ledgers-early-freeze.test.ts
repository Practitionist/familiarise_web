/**
 * @jest-environment node
 */

/**
 * The ledger audit hands wallet drift to its caller as soon as the wallet step
 * finishes, so a run cut off in a later step has already acted on it.
 */

jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_n: string, _o: unknown, fn: () => unknown) => fn(),
}));

const programAssignmentFindMany = jest.fn(async (_a: unknown) => {
  throw new Error("cut off");
});
const db = {
  ledgerReconciliationReport: {
    create: async () => ({ id: "rep_1" }),
  },
  billingAccount: {
    findMany: async () => [
      {
        id: "ba_1",
        walletBalance: 500,
        ownerOrgId: "org_1",
        currency: "INR",
      },
    ],
  },
  ledgerAccount: { findMany: async () => [] },
  ledgerEntry: { groupBy: async () => [] },
  programAssignment: {
    findMany: (a: unknown) => programAssignmentFindMany(a),
  },
  $executeRaw: async () => 0,
  $transaction: (fn: (tx: unknown) => unknown) => fn(db),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { runReconcileLedgers } from "../../scripts/reconcile/reconcile-ledgers";

describe("runReconcileLedgers onWalletDrift", () => {
  it("reports wallet drift before a later step fails", async () => {
    const onWalletDrift = jest.fn(async () => undefined);

    await expect(
      runReconcileLedgers({ scope: "full", onWalletDrift }),
    ).rejects.toThrow("cut off");

    expect(onWalletDrift).toHaveBeenCalledWith("rep_1", [
      expect.objectContaining({
        kind: "WALLET_BALANCE_DRIFT",
        billingAccountId: "ba_1",
        expectedPaise: 0,
        actualPaise: 500,
      }),
    ]);
    expect(programAssignmentFindMany).toHaveBeenCalled();
  });
});
