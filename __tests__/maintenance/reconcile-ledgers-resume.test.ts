/**
 * @jest-environment node
 */

/**
 * #1943 — `POST /api/cleanup/reconcile-ledgers` runs a full-scope ledger
 * reconciliation directly via `runReconcileLedgers({ scope: "full" })` under
 * its cron lock and freezes the wallets it finds drifted.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceUnavailableError: class MaintenanceUnavailableError extends Error {},
  MaintenanceActiveError: class MaintenanceActiveError extends Error {},
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  withCronLock: jest.fn(),
}));

type Args = {
  scope: string;
  onWalletDrift?: (id: string, f: unknown[]) => Promise<void>;
};
const runReconcileLedgers = jest.fn(async (args: Args) => ({
  id: "rep_full",
  scope: args.scope,
  ok: true,
  summary: { discrepanciesCount: 0 },
  findings: [] as unknown[],
}));
const freezeDriftingWallets = jest.fn(
  async (..._a: unknown[]): Promise<unknown[]> => [],
);
const respondToLedgerDrift = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../scripts/reconcile/ledger-drift-response", () => ({
  freezeDriftingWallets: (...a: unknown[]) => freezeDriftingWallets(...a),
  respondToLedgerDrift: (...a: unknown[]) => respondToLedgerDrift(...a),
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => {
  const actual = jest.requireActual<
    typeof import("../../scripts/reconcile/reconcile-ledgers")
  >("../../scripts/reconcile/reconcile-ledgers");
  return {
    ...actual,
    runReconcileLedgers: (...args: [Args]) => runReconcileLedgers(...args),
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/cleanup/[job]/route";

const SECRET = "test-cron-secret";

function invokeReconcile(): NextRequest {
  return new NextRequest("https://x.test/api/cleanup/reconcile-ledgers", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

describe("POST /api/cleanup/reconcile-ledgers", () => {
  it("runs a full-scope audit, freezes from its wallet step and reports the frozen wallets", async () => {
    const drift = { kind: "WALLET_BALANCE_DRIFT", billingAccountId: "ba_1" };
    freezeDriftingWallets.mockResolvedValueOnce([{ billingAccountId: "ba_1" }]);
    runReconcileLedgers.mockImplementationOnce(async (args: Args) => {
      await args.onWalletDrift?.("rep_full", [drift]);
      return {
        id: "rep_full",
        scope: args.scope,
        ok: false,
        summary: { discrepanciesCount: 1 },
        findings: [drift],
      };
    });
    const res = await POST(invokeReconcile(), {
      params: Promise.resolve({ job: "reconcile-ledgers" }),
    });

    expect(res.status).toBe(207);
    expect(runReconcileLedgers).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "full" }),
    );
    expect(freezeDriftingWallets).toHaveBeenCalledWith("rep_full", [drift]);
    expect(respondToLedgerDrift).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      status: "OK",
      report: { id: "rep_full", scope: "full", ok: false },
      frozenWallets: [{ billingAccountId: "ba_1" }],
    });
  });

  it("freezes from the audit's wallet step and fails the route after a freeze error", async () => {
    const drift = { kind: "WALLET_BALANCE_DRIFT", billingAccountId: "ba_1" };
    freezeDriftingWallets.mockRejectedValueOnce(new Error("db down"));
    runReconcileLedgers.mockImplementationOnce(async (args: Args) => {
      await args.onWalletDrift?.("rep_full", [drift]);
      return {
        id: "rep_full",
        scope: args.scope,
        ok: false,
        summary: { discrepanciesCount: 1 },
        findings: [drift],
      };
    });

    const res = await POST(invokeReconcile(), {
      params: Promise.resolve({ job: "reconcile-ledgers" }),
    });

    expect(freezeDriftingWallets).toHaveBeenCalledWith("rep_full", [drift]);
    expect(respondToLedgerDrift).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });
});
