/**
 * @jest-environment node
 */

/**
 * PM-15 sibling (reconcile-payout-status delegation) — the payout
 * reconciliation cron must record a gateway-confirmed payout through the
 * canonical handlePayoutWebhook, NOT a bare inline `status=COMPLETED` +
 * `earnings PAID` flip. The old inline path skipped TDS recording, the payout
 * ledger postings (revenue/payable counters), and the UTR.
 *
 * Mirrors stuck-payouts-tds-reconcile.test.ts: we mock handlePayoutWebhook (the
 * same boundary every webhook test uses — the index drags in the Stream ESM
 * graph Jest can't transform) and assert the reconciler DELEGATES with the
 * mapped status + UTR and never performs the bare flip. The money recording
 * inside handlePayoutWebhook (TDS + ledger) is pinned separately in
 * stuck-payouts-money-handler.test.ts, which drives the REAL handler.
 */

const handlePayoutWebhook = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1000,
  CronLockHeldError: class extends Error {},
  CronLockUnavailableError: class extends Error {},
}));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  handlePayoutWebhook: (...a: unknown[]) => handlePayoutWebhook(...a),
}));

// #1757 — the retire path reports ONE expected warning per run; count it.
const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
  reportSentryError: jest.fn(),
}));

type Row = Record<string, unknown>;

const STALE_PAYOUT: Row = {
  id: "po_stale_1",
  consultantProfileId: "cprof_1",
  provider: "RAZORPAY",
  providerPayoutId: "pout_live_1",
  amount: 100000,
  currency: "INR",
  status: "PROCESSING",
  updatedAt: new Date(0),
  consultantProfile: { user: { name: "Asha", email: "asha@x.com" } },
};

let payoutRow: Row;

// `var` (not let/const): the hoisted jest.mock factory runs before this
// declaration line, and only `var` is initialized (to undefined) at hoist time
// — a let/const would still be in its TDZ when the factory assigns to it.
// eslint-disable-next-line no-var
var prismaStub: {
  consultantPayout: { findMany: jest.Mock; update: jest.Mock };
  consultantEarnings: { updateMany: jest.Mock };
  $disconnect: jest.Mock;
};

jest.mock("../../lib/prisma", () => {
  prismaStub = {
    consultantPayout: {
      findMany: jest.fn(async () => [payoutRow]),
      update: jest.fn(async ({ data }: { data: Row }) => {
        Object.assign(payoutRow, data);
        return payoutRow;
      }),
    },
    consultantEarnings: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $disconnect: jest.fn(async () => {}),
  };
  return { __esModule: true, default: prismaStub };
});

import { reconcilePayoutStatus } from "../../scripts/payouts/reconcile-payout-status";

beforeEach(() => {
  jest.clearAllMocks();
  payoutRow = { ...STALE_PAYOUT };
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "processed", utr: "UTR1234567890" }),
  });
});

describe("PM-15 — payout reconcile delegates to handlePayoutWebhook", () => {
  it("processed payout → delegates COMPLETED + UTR to handlePayoutWebhook, not a bare status flip", async () => {
    const result = await reconcilePayoutStatus();

    expect(result.reconciledCount).toBe(1);
    expect(result.completedCount).toBe(1);

    // Delegated to the canonical engine with the mapped status, gateway id, and
    // the bank UTR (so TDS + ledger post and the UTR is persisted — none of
    // which the old inline flip did).
    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    expect(handlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_live_1",
      "COMPLETED",
      undefined,
      "UTR1234567890",
    );

    // The OLD inline money flip must be gone: no direct COMPLETED status write
    // and no direct earnings→PAID write on the reconciler.
    const directCompletedFlip = prismaStub.consultantPayout.update.mock.calls.some(
      ([arg]: [{ data?: Row }]) => arg?.data?.status === "COMPLETED",
    );
    expect(directCompletedFlip).toBe(false);
    const directEarningsPaid = prismaStub.consultantEarnings.updateMany.mock.calls.some(
      ([arg]: [{ data?: Row }]) => arg?.data?.status === "PAID",
    );
    expect(directEarningsPaid).toBe(false);
  });

  it("reversed payout → delegates FAILED with the net-zero failure reason", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "reversed", failure_reason: "bounced" }),
    });

    await reconcilePayoutStatus();

    // Razorpay `reversed` (pre-completion) maps to FAILED; the reconciler
    // delegates the unlink + TDS-reversal to the canonical handler with the
    // net-zero round-trip note rather than leaving earnings linked.
    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    const [provider, id, status, reason] =
      handlePayoutWebhook.mock.calls[0];
    expect(provider).toBe("RAZORPAY");
    expect(id).toBe("pout_live_1");
    expect(status).toBe("FAILED");
    expect(reason).toContain("net-zero round trip");
    expect(reason).toContain("bounced");
    // #873 — a reversed payout has no settlement UTR; the 5th arg must be undefined.
    const [, , , , utr] = handlePayoutWebhook.mock.calls[0];
    expect(utr).toBeUndefined();
  });

  // #1407 — RazorpayX `failed` (the bank refused a queued payout) had no arm
  // here while Stripe's did, so the payout fell through as an unknown status
  // and was skipped — which is the exact cohort this sweep exists for.
  it("gateway `failed` → delegates FAILED, not skipped as an unknown status", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "failed", failure_reason: "account closed" }),
    });

    const result = await reconcilePayoutStatus();

    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    const [provider, id, status, reason, utr] =
      handlePayoutWebhook.mock.calls[0];
    expect(provider).toBe("RAZORPAY");
    expect(id).toBe("pout_live_1");
    expect(status).toBe("FAILED");
    // A plain `failed` is not the pre-completion reversal, so it carries the
    // gateway's own reason without the net-zero note.
    expect(reason).toBe("account closed");
    expect(reason).not.toContain("net-zero");
    expect(utr).toBeUndefined();
    expect(result.failedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
  });

  it("still-processing payout → no delegation (status unchanged)", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "processing" }),
    });

    await reconcilePayoutStatus();

    expect(handlePayoutWebhook).not.toHaveBeenCalled();
  });
});

/**
 * #1757 — a PROCESSING row whose gateway id the gateway has no record of (a
 * seed `po_…`, or a real orphan) used to fail the whole run on every tick.
 * It is now retired once through the canonical FAILED handler and reported
 * as an expected warning; a FAILED row leaves the cohort, so run two is silent.
 */
describe("#1757 — unknown gateway id is retired once, not a run failure", () => {
  it("RazorpayX 'does not exist' → FAILED/GATEWAY_UNKNOWN_ID via the handler, success:true, retired:1", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: "BAD_REQUEST_ERROR",
            description: "The id provided does not exist",
          },
        }),
      });
    // The real handler CASes PROCESSING → FAILED; mirror that on the row.
    handlePayoutWebhook.mockImplementationOnce(async () => {
      payoutRow.status = "FAILED";
    });
    // The cohort query only walks PENDING/PROCESSING, so a FAILED row is gone.
    prismaStub.consultantPayout.findMany.mockImplementation(async () =>
      payoutRow.status === "PROCESSING" ? [payoutRow] : [],
    );

    const first = await reconcilePayoutStatus();

    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    expect(handlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_live_1",
      "FAILED",
      "GATEWAY_UNKNOWN_ID",
    );
    expect(first.success).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.retiredCount).toBe(1);
    expect(first.retired).toEqual(["po_stale_1"]);
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(reportSentryMessage.mock.calls[0][1]).toMatchObject({
      expected: true,
      extra: { retired: ["po_stale_1"] },
    });

    const second = await reconcilePayoutStatus();
    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    expect(second.retiredCount).toBe(0);
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
  });

  it("a 5xx from the gateway keeps today's behaviour: run error, not retired", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: "SERVER_ERROR" } }),
      });

    const result = await reconcilePayoutStatus();

    expect(handlePayoutWebhook).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.retiredCount).toBe(0);
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });
});
