/**
 * @jest-environment node
 */

/**
 * Full and organization audits share the scheduled slice's lease and can
 * resume an idle checkpoint without a separate report-age gate.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));

const findMany = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ledgerReconciliationReport: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
    opsActionLog: { create: jest.fn(async () => ({ id: "ops_1" })) },
  },
}));

type RunArgs = {
  scope: string;
  triggeredById?: string;
  onWalletDrift?: (id: string, findings: Finding[]) => Promise<void>;
};
const runReconcileLedgers = jest.fn(
  async (
    _args: RunArgs,
  ): Promise<{ id: string; ok: boolean; findings: Finding[] }> => ({
    id: "rep_1",
    ok: true,
    findings: [],
  }),
);
const freezeDriftedWallets = jest.fn(
  async (_report: unknown, frozen: unknown[]) => frozen,
);
jest.mock("../../lib/payments/wallet-freeze", () => ({
  freezeDriftedWallets: (...args: [unknown, unknown[]]) =>
    freezeDriftedWallets(...args),
}));
jest.mock("../../scripts/reconcile/reconcile-ledgers", () => ({
  runReconcileLedgers: (args: RunArgs) => runReconcileLedgers(args),
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/reconcile-ledgers/route";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import type { Finding } from "../../scripts/reconcile/reconcile-ledgers";

const fetchMock = jest.fn(async () => new Response(null, { status: 202 }));

const REASON = { reason: "nightly drift check" };
const ROUTE = { params: Promise.resolve({}) };

function post(body: Record<string, unknown>) {
  return new NextRequest("https://x.test/api/admin/reconcile-ledgers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...REASON, ...body }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("POST /api/admin/reconcile-ledgers", () => {
  it("runs a full-scope reconciliation in-process and answers 200 with the report", async () => {
    const res = await POST(post({}), ROUTE);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      id: "rep_1",
      ok: true,
      findings: [],
      frozenWallets: [],
    });
    expect(runReconcileLedgers).toHaveBeenCalledWith({
      scope: "full",
      triggeredById: "admin_1",
      onWalletDrift: expect.any(Function),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes idle checkpoints through the audit instead of refusing a RUNNING report", async () => {
    const res = await POST(post({}), ROUTE);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("rep_1");
    expect(findMany).not.toHaveBeenCalled();
    expect(runReconcileLedgers).toHaveBeenCalled();
  });

  it("answers 409 when the reconcile-ledgers cron lock is held", async () => {
    runReconcileLedgers.mockRejectedValueOnce(
      new CronLockHeldError("reconcile-ledgers"),
    );

    const res = await POST(post({}), ROUTE);
    expect(res.status).toBe(409);
  });

  it("freezes the wallet page even when a later comparison fails", async () => {
    const drift: Finding = {
      kind: "WALLET_BALANCE_DRIFT",
      billingAccountId: "account-1",
      expectedPaise: 100,
      actualPaise: 0,
      deltaPaise: -100,
    };
    runReconcileLedgers.mockImplementationOnce(async (args) => {
      await args.onWalletDrift?.("rep_1", [drift]);
      throw new Error("later comparison failed");
    });
    const res = await POST(post({}), ROUTE);
    expect(res.status).toBe(500);
    expect(freezeDriftedWallets).toHaveBeenCalledWith(
      { id: "rep_1", findings: [drift] },
      [],
    );
  });

  it("refuses a run without a reason", async () => {
    const res = await POST(
      new NextRequest("https://x.test/api/admin/reconcile-ledgers", {
        method: "POST",
        body: "{}",
      }),
      ROUTE,
    );
    expect(res.status).toBe(400);
    expect(runReconcileLedgers).not.toHaveBeenCalled();
  });

  it("keeps an org-scoped run synchronous", async () => {
    const res = await POST(post({ organizationId: "org_1" }), ROUTE);

    expect(res.status).toBe(200);
    expect(runReconcileLedgers).toHaveBeenCalledWith({
      scope: "org:org_1",
      organizationId: "org_1",
      triggeredById: "admin_1",
      onWalletDrift: expect.any(Function),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
