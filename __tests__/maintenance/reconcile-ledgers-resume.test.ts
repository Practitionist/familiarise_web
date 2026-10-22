/**
 * @jest-environment node
 */

/**
 * Scheduled slices retain full-scope coverage and freeze wallet pages before
 * later comparisons, with one fatal alert per invocation.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
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
  summary: { discrepanciesCount: 0, status: "COMPLETED" },
  findings: [] as unknown[],
}));
const freezeDriftedWallets = jest.fn(
  async (_report: unknown, frozen: unknown[]): Promise<unknown[]> => frozen,
);
const reportWalletDriftFreeze = jest.fn();
jest.mock("../../lib/payments/wallet-freeze", () => ({
  freezeDriftedWallets: (...args: [unknown, unknown[]]) =>
    freezeDriftedWallets(...args),
}));
const respondToLedgerDrift = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../scripts/reconcile/ledger-drift-response", () => ({
  reportWalletDriftFreeze: (...a: unknown[]) => reportWalletDriftFreeze(...a),
  respondToLedgerDrift: (...a: unknown[]) => respondToLedgerDrift(...a),
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => {
  const actual = jest.requireActual<
    typeof import("../../scripts/reconcile/reconcile-ledgers")
  >("../../scripts/reconcile/reconcile-ledgers");
  return {
    ...actual,
    runReconcileLedgersSlice: (...args: [Args]) => runReconcileLedgers(...args),
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
    freezeDriftedWallets.mockImplementationOnce(async (_report, frozen) => {
      frozen.push({ billingAccountId: "ba_1" });
      return frozen;
    });
    runReconcileLedgers.mockImplementationOnce(async (args: Args) => {
      await args.onWalletDrift?.("rep_full", [drift]);
      return {
        id: "rep_full",
        scope: args.scope,
        ok: false,
        summary: { discrepanciesCount: 1, status: "COMPLETED" },
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
    expect(freezeDriftedWallets).toHaveBeenCalledWith(
      { id: "rep_full", findings: [drift] },
      expect.any(Array),
    );
    expect(reportWalletDriftFreeze).toHaveBeenCalledTimes(1);
    expect(respondToLedgerDrift).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      status: "OK",
      report: { id: "rep_full", scope: "full", ok: false },
      frozenWallets: [{ billingAccountId: "ba_1" }],
    });
  });

  it("freezes from the audit's wallet step and fails the route after a freeze error", async () => {
    const drift = { kind: "WALLET_BALANCE_DRIFT", billingAccountId: "ba_1" };
    freezeDriftedWallets.mockRejectedValueOnce(new Error("db down"));
    runReconcileLedgers.mockImplementationOnce(async (args: Args) => {
      await args.onWalletDrift?.("rep_full", [drift]);
      return {
        id: "rep_full",
        scope: args.scope,
        ok: false,
        summary: { discrepanciesCount: 1, status: "COMPLETED" },
        findings: [drift],
      };
    });

    const res = await POST(invokeReconcile(), {
      params: Promise.resolve({ job: "reconcile-ledgers" }),
    });

    expect(freezeDriftedWallets).toHaveBeenCalledWith(
      { id: "rep_full", findings: [drift] },
      expect.any(Array),
    );
    expect(reportWalletDriftFreeze).toHaveBeenCalledWith(
      "rep_full",
      [drift],
      [],
    );
    expect(respondToLedgerDrift).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });

  it("accumulates every wallet page and alerts once while an audit remains RUNNING", async () => {
    const first = { kind: "WALLET_BALANCE_DRIFT", billingAccountId: "ba_1" };
    const second = { kind: "WALLET_BALANCE_DRIFT", billingAccountId: "ba_2" };
    freezeDriftedWallets.mockImplementation(async (_report, frozen) => {
      frozen.push({ billingAccountId: `ba_${frozen.length + 1}` });
      return frozen;
    });
    runReconcileLedgers.mockImplementationOnce(async (args: Args) => {
      await args.onWalletDrift?.("rep_full", [first]);
      await args.onWalletDrift?.("rep_full", [second]);
      return {
        id: "rep_full",
        scope: args.scope,
        ok: false,
        summary: { discrepanciesCount: 2, status: "RUNNING" },
        findings: [first, second],
      };
    });
    const res = await POST(invokeReconcile(), {
      params: Promise.resolve({ job: "reconcile-ledgers" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "RUNNING",
      frozenWallets: [
        { billingAccountId: "ba_1" },
        { billingAccountId: "ba_2" },
      ],
    });
    expect(reportWalletDriftFreeze).toHaveBeenCalledTimes(1);
    expect(reportWalletDriftFreeze).toHaveBeenCalledWith(
      "rep_full",
      [first, second],
      expect.any(Array),
    );
    expect(respondToLedgerDrift).not.toHaveBeenCalled();
  });
});
