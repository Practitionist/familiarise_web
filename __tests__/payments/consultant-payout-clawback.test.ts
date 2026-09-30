/**
 * @jest-environment node
 */

/**
 * The automatic consultant clawback for a lost dispute on a PAID earning
 * (`CONSULTANT_CLAWBACK` in `lib/payments/operations/reversal-engine.ts`).
 *
 * Pins the four properties the gap report calls out:
 *
 *   1. it posts exactly ONE balanced journal, and the journal is a receivable
 *      (`Dr CONSULTANT_RECEIVABLE / Cr PLATFORM_FEE`) rather than the org
 *      rail's `Dr CASH / Cr ORG_PAYABLE` — the consultant rail has no
 *      reverse-transfer, so a CASH debit would assert money the platform does
 *      not hold;
 *   2. it is idempotent — a second delivery of the same (refund, payout) posts
 *      nothing, and a different dispute against the same payout DOES post again;
 *   3. the key is deterministic and unique per (refund, payout);
 *   4. the amount is passed through untouched, so it can never disagree with the
 *      earnings reversal it is prorated against.
 *
 * `postLedgerTxn` is stubbed (the real one is exercised in its own suite); what
 * is asserted here is the SHAPE of what we hand it and our own pre-checks.
 */

import { applyReversal } from "@/lib/payments/operations/reversal-engine";
import {
  ledgerAccountId,
  postLedgerTxn,
  type PostLedgerTxnInput,
} from "@/lib/payments/ledger/post";

jest.mock("../../lib/payments/ledger/post", () => {
  const actual = jest.requireActual("../../lib/payments/ledger/post");
  return {
    ...actual,
    postLedgerTxn: jest.fn().mockResolvedValue({ transactionId: "ltx_1", created: true }),
  };
});
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../lib/enterprise/system-events", () => {
  const recordSystemError = jest.fn().mockResolvedValue(undefined);
  return {
    recordSystemError,
    recordSystemErrorSafe: recordSystemError,
    recordSystemEventSafe: jest.fn(),
  };
});
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const mockedPost = postLedgerTxn as jest.MockedFunction<typeof postLedgerTxn>;

/**
 * `postLedgerTxn(db, input)` — the input is the SECOND argument, so
 * `mock.calls[0][0]` is the tx. Asserting on `[0]` silently reads
 * `undefined.postings` and passes vacuously.
 */
function LAST_INPUT(): PostLedgerTxnInput {
  return mockedPost.mock.calls[0][1];
}

/** Σ(DEBIT) === Σ(CREDIT) — the property `postLedgerTxn` itself asserts. */
function assertBalanced(postings: PostLedgerTxnInput["postings"]): void {
  let debit = 0;
  let credit = 0;
  for (const p of postings) {
    if (p.direction === "DEBIT") debit += p.amountPaise;
    else credit += p.amountPaise;
  }
  expect(debit).toBe(credit);
}

function makeTx(overrides: { alreadyPosted?: boolean; payout?: unknown } = {}) {
  return {
    ledgerTransaction: {
      findUnique: jest
        .fn()
        .mockResolvedValue(overrides.alreadyPosted ? { id: "ltx-1" } : null),
    },
    consultantPayout: {
      findUnique: jest.fn().mockResolvedValue(
        "payout" in overrides
          ? overrides.payout
          : { id: "cpay-1", clawbackInitiatedAt: null },
      ),
      // W1a — the counter that keeps `ConsultantPayout` in step with its
      // journal, mirroring `reversePayoutClawback` for the org pair. Without
      // it the outstanding recovery is only a ledger balance, with no counter
      // for the reconciler to compare the journal against.
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

/** The stub's own shape, so tests can read `tx.consultantPayout.update`. */
type TxStub = ReturnType<typeof makeTx>;

/**
 * A hand-rolled prisma stub cannot structurally satisfy the full `Tx` type.
 * Cast once here — at the boundary — instead of typing `makeTx` as `never`,
 * which also made `tx.consultantPayout.update` unreadable for the counter
 * assertions below.
 */
const asTx = (tx: TxStub) => tx as unknown as Parameters<typeof applyReversal>[0];

const SOURCE = {
  kind: "CONSULTANT_CLAWBACK",
  consultantPayoutId: "cpay-1",
  consultantProfileId: "cp_xyz",
} as const;

beforeEach(() => {
  mockedPost.mockClear();
  mockedPost.mockResolvedValue({ transactionId: "ltx_1", created: true });
});

describe("applyReversal — CONSULTANT_CLAWBACK: the posting itself", () => {
  it("books the recovery as a consultant-scoped receivable, not a CASH debit", async () => {
    const tx = makeTx();

    const res = await applyReversal(asTx(tx), {
      source: SOURCE,
      amountPaise: 50_000,
      reason: "chargeback lost (dispute disp_1)",
      refundId: "dispute:disp_1",
    });

    expect(res.kind).toBe("CONSULTANT_CLAWBACK");
    expect(res.clawbackPosted).toBe(true);
    expect(res.cascades).toHaveLength(0);
    expect(mockedPost).toHaveBeenCalledTimes(1);

    const arg = LAST_INPUT();
    // One append-only txn: never a mutation of the original `payout:<id>` row.
    expect(arg.kind).toBe("PAYOUT");
    expect(arg.payoutId).toBe("cpay-1");
    assertBalanced(arg.postings);

    const [debit, credit] = arg.postings;
    // The cash never came back, so CASH must not move.
    expect(arg.postings.map((p) => p.account.kind)).not.toContain("CASH");
    expect(debit).toEqual({
      account: { kind: "CONSULTANT_RECEIVABLE", consultantProfileId: "cp_xyz" },
      direction: "DEBIT",
      amountPaise: 50_000,
    });
    expect(credit).toEqual({
      account: { kind: "PLATFORM_FEE" },
      direction: "CREDIT",
      amountPaise: 50_000,
    });

    // Scoping: the account resolves to a deterministic id unique per
    // consultant, and NOT to the org-scoped id `getOrgReceivables` reads — so
    // the receivable never leaks into an org's receivables page.
    expect(ledgerAccountId(debit.account)).toBe("CONSULTANT_RECEIVABLE|_|cp_xyz|INR");
    expect(
      ledgerAccountId({ kind: "ORG_RECEIVABLE", organizationId: "org-1" }),
    ).not.toBe(ledgerAccountId(debit.account));
  });

  it("passes the amount through untouched, so it cannot disagree with the earnings reversal", async () => {
    // The dispute path hands us the integer it computed for the CASH recovery;
    // nothing here re-derives a proration factor, so a partial dispute can
    // never round two ways. (The GROSS→NET scale is applied by the CALLER,
    // before this point — see the net-of-TDS cases in
    // dispute-consultant-clawback.test.ts. Here the input is simply honoured.)
    const tx = makeTx();
    await applyReversal(asTx(tx), {
      source: SOURCE,
      amountPaise: 33_333,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    expect(LAST_INPUT().postings[0].amountPaise).toBe(33_333);
    expect(LAST_INPUT().postings[1].amountPaise).toBe(33_333);
  });

  it("increments the payout's clawback counter and stamps it once", async () => {
    const tx = makeTx();
    await applyReversal(asTx(tx), {
      source: SOURCE,
      amountPaise: 50_000,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    const update = tx.consultantPayout.update;
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "cpay-1" });
    expect(arg.data.clawbackAmountPaise).toEqual({ increment: 50_000 });
    // First clawback on this payout → stamp it.
    expect(arg.data.clawbackInitiatedAt).toEqual(expect.any(Date));
  });

  it("does NOT re-stamp clawbackInitiatedAt on a second, different clawback", async () => {
    // A second dispute against the same payout must accumulate the amount
    // without moving the "recovery first became owed" timestamp — `undefined`
    // is Prisma's "leave this column alone".
    const tx = makeTx({ payout: { id: "cpay-1", clawbackInitiatedAt: new Date(0) } });
    await applyReversal(asTx(tx), {
      source: SOURCE,
      amountPaise: 1_000,
      reason: "r",
      refundId: "dispute:disp_2",
    });
    const arg = tx.consultantPayout.update.mock.calls[0][0];
    expect(arg.data.clawbackAmountPaise).toEqual({ increment: 1_000 });
    expect(arg.data.clawbackInitiatedAt).toBeUndefined();
  });

  it("does not touch the counter when the journal is already posted", async () => {
    // Replay: the idempotency probe short-circuits, so neither the journal nor
    // the counter may move — a replay must not double-count the receivable.
    const tx = makeTx({ alreadyPosted: true });
    const res = await applyReversal(asTx(tx), {
      source: SOURCE,
      amountPaise: 50_000,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    expect(res.clawbackPosted).toBe(false);
    expect(tx.consultantPayout.update).not.toHaveBeenCalled();
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe("applyReversal — CONSULTANT_CLAWBACK: the idempotency key", () => {
  it("is deterministic and unique per (refund, payout)", async () => {
    await applyReversal(asTx(makeTx()), {
      source: SOURCE,
      amountPaise: 1,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    await applyReversal(asTx(makeTx()), {
      source: { ...SOURCE, consultantPayoutId: "cpay-2" },
      amountPaise: 1,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    await applyReversal(asTx(makeTx()), {
      source: SOURCE,
      amountPaise: 1,
      reason: "r",
      refundId: "dispute:disp_2",
    });

    const keys = mockedPost.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys).toEqual([
      "clawback:dispute:disp_1:cpay-1",
      "clawback:dispute:disp_1:cpay-2",
      "clawback:dispute:disp_2:cpay-1",
    ]);
    expect(new Set(keys).size).toBe(3);
    // Same prefix convention the org clawback and reconcile's `clawback:*`
    // scan both rely on.
    for (const k of keys) expect(k.startsWith("clawback:")).toBe(true);
  });

  it("posts nothing on a redelivery of the same (refund, payout)", async () => {
    const res = await applyReversal(asTx(makeTx({ alreadyPosted: true })), {
      source: SOURCE,
      amountPaise: 50_000,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    expect(res.clawbackPosted).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("posts nothing for a zero or negative amount", async () => {
    for (const amountPaise of [0, -1]) {
      const res = await applyReversal(asTx(makeTx()), {
        source: SOURCE,
        amountPaise,
        reason: "r",
        refundId: "dispute:disp_1",
      });
      expect(res.clawbackPosted).toBe(false);
    }
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe("applyReversal — CONSULTANT_CLAWBACK: failure handling", () => {
  it("reports and rethrows so the enclosing transaction rolls the earnings back with it", async () => {
    const { recordSystemError } = jest.requireMock(
      "../../lib/enterprise/system-events",
    ) as { recordSystemError: jest.Mock };
    recordSystemError.mockClear();
    mockedPost.mockRejectedValueOnce(new Error("journal unbalanced"));

    await expect(
      applyReversal(asTx(makeTx()), {
        source: SOURCE,
        amountPaise: 50_000,
        reason: "r",
        refundId: "dispute:disp_1",
      }),
    ).rejects.toThrow("journal unbalanced");

    // An SSI abort must never leave a half-applied earnings reversal behind a
    // page claiming recovery — the durable row explains the rollback.
    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: null,
        category: "LEDGER",
        context: expect.objectContaining({
          consultantPayoutId: "cpay-1",
          consultantProfileId: "cp_xyz",
          refundId: "dispute:disp_1",
        }),
      }),
    );
  });

  it("no-ops (without posting) when the ConsultantPayout cannot be resolved", async () => {
    const res = await applyReversal(asTx(makeTx({ payout: null })), {
      source: SOURCE,
      amountPaise: 50_000,
      reason: "r",
      refundId: "dispute:disp_1",
    });
    expect(res.clawbackPosted).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
