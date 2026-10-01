/**
 * @jest-environment node
 */

/**
 * #CASC (org twin) — CAS-in-WHERE for the REFUNDED transition on
 * `OrganizationEarnings`, and proof that generalising the consultant helper did
 * not move the consultant's behaviour.
 *
 * `applyRefundCascade` Step 7 and `reverseFreeCreditSettlement` were the two
 * org twins of the consultant CAS, and both were still
 * `update({ where: { id } })` — no status predicate, no pinned
 * `refundedAmountPaise`, no cap re-derivation. They leaned on
 * `assertEarningStatusTransitionLegal`, which asserts over a value read into JS
 * and is therefore advisory: two concurrent org reversals could both read READY,
 * both pass it, and both write, over-clawing the org's share and driving the
 * payout readyAmount negative.
 *
 * The fix generalises the ONE shared writer rather than adding a fourth copy, so
 * the columns are inputs and the CAS stays single. Pinned here:
 *  - an org reversal refuses a second concurrent writer (count 0, no double amount)
 *  - the cap holds across two racing partials, and the value written is ABSOLUTE
 *  - a PAID org earning still moves to REFUNDED (its force equivalent) while the
 *    terminal REFUNDED row is still refused before any write
 *  - a zero outcome means "post nothing", never a 0-paise journal
 *  - the consultant path is byte-for-byte unchanged, and only ONE copy of the CAS
 *    logic survives anywhere in the tree
 *
 * Every fake HONOURS the WHERE clause: a mock that ignored the predicates would
 * pass regardless of the code under test.
 */

const mockApplyReversal = jest.fn();
const mockReverseCredits = jest.fn();
const mockReverseUtilization = jest.fn();
const mockPostLedgerTxn = jest.fn();
const mockRecordTdsReversal = jest.fn();
const mockPaymentFindUnique = jest.fn();
const mockFindDeduped = jest.fn(async (..._a: unknown[]) => null as unknown);

jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(null),
  attemptTrigger: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  MONEY_EMAIL_TYPES: { REFUND_PROCESSED: "REFUND_PROCESSED" },
  stageRefundProcessedEmail: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: jest.fn(),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) => mockReverseUtilization(...a),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => mockReverseCredits(...a),
  restoreCreditsForPaymentUpTo: jest.fn(
    async (_p: string, _t: unknown, n: number) => n,
  ),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(),
  findDedupedRefund: (...a: unknown[]) => mockFindDeduped(...a),
  isDedupeKeyConflict: () => false,
  RefundValidationError: class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  },
}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => mockApplyReversal(...a),
  // The REAL clawback journal, so "posted nothing" is observable rather than
  // assumed: `postLedgerTxn` is the boundary mock above.
  postPayoutClawback: jest.requireActual(
    "../../lib/payments/operations/reversal-engine",
  ).postPayoutClawback,
}));

const tx: Record<string, any> = {
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
  },
  referralCreditUsage: { findMany: jest.fn() },
  appointment: { findUnique: jest.fn() },
  appointmentOccurrence: { findMany: jest.fn() },
  refund: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment: { findUniqueOrThrow: jest.fn() },
  consultantEarnings: {
    update: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
  },
  organizationEarnings: {
    update: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => null),
  },
  organizationPayout: { update: jest.fn() },
  orgAuditLog: { create: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
    },
    refund: { findUnique: async () => ({ metadata: {} }) },
    $transaction: (fn: (txClient: unknown) => unknown) => fn(tx),
  },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EarningStatus } from "@prisma/client";

import {
  applyCappedEarningReversal,
  applyCappedOrgEarningReversal,
  REFUNDABLE_EARNING_SOURCE,
  REFUNDABLE_ORG_EARNING_SOURCE,
} from "../../lib/payments/payouts/earning-reversal-cas";
import { IllegalEarningStatusTransitionError } from "../../lib/payments/payouts/earning-status";
import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";

const PAYMENT_ID = "pay-free-org-1";

// ---------------------------------------------------------------------------
// WHERE-honouring fakes
// ---------------------------------------------------------------------------

type OrgRow = {
  id: string;
  status: EarningStatus;
  orgSharePaise: number;
  refundedAmountPaise: number;
  organizationId: string;
  orgPayoutId: string | null;
  orgPayout: { status: string; clawbackInitiatedAt: Date | null } | null;
};

const orgRow = (over: Partial<OrgRow> = {}): OrgRow => ({
  id: "oe-1",
  status: EarningStatus.READY,
  orgSharePaise: 8_000,
  refundedAmountPaise: 0,
  organizationId: "org-1",
  orgPayoutId: null,
  orgPayout: null,
  ...over,
});

type ConsRow = {
  id: string;
  status: EarningStatus;
  consultantSharePaise: number;
  refundedShareAmount: number;
};

/**
 * A delegate whose `updateMany` really evaluates `where` (status-in + the pinned
 * amount) and whose `findUnique` really re-reads. `refuseAlways` models a row a
 * concurrent writer keeps outrunning, i.e. the worst-case two-refusal path.
 */
function makeDelegate<T extends Record<string, any>>(
  rows: T[],
  amountColumn: string,
  refuseAlways = false,
) {
  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (refuseAlways) return { count: 0 };
    let count = 0;
    for (const r of rows) {
      if (where.id !== undefined && where.id !== r.id) continue;
      if (where.status !== undefined) {
        const allowed = where.status.in ?? [where.status];
        if (!allowed.includes(r.status)) continue;
      }
      if (
        where[amountColumn] !== undefined &&
        where[amountColumn] !== r[amountColumn]
      ) {
        continue;
      }
      count++;
      Object.assign(r, data);
    }
    return { count };
  });
  const findUnique = jest.fn(async ({ where }: any) => {
    const r = rows.find((x) => x.id === where.id);
    if (!r) return null;
    return { status: r.status, [amountColumn]: r[amountColumn] };
  });
  return { updateMany, findUnique };
}

const orgStore = (rows: OrgRow[], refuseAlways = false) => {
  const d = makeDelegate(rows, "refundedAmountPaise", refuseAlways);
  return { ...d, db: { organizationEarnings: d } as never };
};

const consStore = (rows: ConsRow[], refuseAlways = false) => {
  const d = makeDelegate(rows, "refundedShareAmount", refuseAlways);
  return { ...d, db: { consultantEarnings: d } as never };
};

const whereOf = (m: jest.Mock, call = 0) => m.mock.calls[call][0].where;
const dataOf = (m: jest.Mock, call = 0) => m.mock.calls[call][0].data;

// ---------------------------------------------------------------------------
// 1. A second concurrent writer is refused
// ---------------------------------------------------------------------------

describe("org capped earning reversal — CAS-in-WHERE (org twin)", () => {
  it("refuses a second concurrent writer instead of double-amounting", async () => {
    const r = orgRow();
    const { db, updateMany } = orgStore([r]);
    // BOTH writers read the same state before either writes — that is the race.
    const writerA = { ...r };
    const writerB = { ...r };

    const a = await applyCappedOrgEarningReversal(db, writerA, 8_000);
    const b = await applyCappedOrgEarningReversal(db, writerB, 8_000);

    expect(a).toMatchObject({
      reversedPaise: 8_000,
      refundedAmountPaise: 8_000,
      fullyRefunded: true,
      lostRace: false,
    });
    // The refusal is a real conditional write that matched nothing…
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(whereOf(updateMany, 1).refundedAmountPaise).toBe(0);
    // …and it is reported, never assumed to have landed.
    expect(b).toMatchObject({ reversedPaise: 0, lostRace: true });
    // One reversal total, capped at the share — not 16_000.
    expect(r.refundedAmountPaise).toBe(8_000);
    expect(r.refundedAmountPaise).toBeLessThanOrEqual(r.orgSharePaise);
    expect(r.status).toBe(EarningStatus.REFUNDED);
  });

  it("pins the pre-read status and the pre-read value in the WHERE", async () => {
    const r = orgRow();
    const { db, updateMany } = orgStore([r]);

    await applyCappedOrgEarningReversal(db, { ...r }, 8_000);

    const where = whereOf(updateMany);
    expect(where.id).toBe("oe-1");
    // The ORG column is pinned — `refundedShareAmount` would silently match
    // nothing and every org reversal would report a lost race.
    expect(where.refundedAmountPaise).toBe(0);
    // The exact pre-read status is pinned, so any status change re-reads.
    expect(where.status).toBe(EarningStatus.READY);
    expect(dataOf(updateMany)).toEqual({
      refundedAmountPaise: 8_000,
      status: EarningStatus.REFUNDED,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The cap holds across two racing partials; the write is absolute
// ---------------------------------------------------------------------------

describe("org capped earning reversal — the cap under a partial race", () => {
  it("keeps the cap when two partial reversals race, writing an ABSOLUTE value", async () => {
    const r = orgRow();
    const { db, updateMany } = orgStore([r]);
    // ONE stale read shared by both writers. Spreading `r` afresh per call would
    // hand writer B a post-A snapshot, so it would legitimately win first try
    // and `lostRace` would be false for the right reason — testing nothing.
    const stale = { ...r };

    const a = await applyCappedOrgEarningReversal(db, { ...stale }, 5_000);
    const b = await applyCappedOrgEarningReversal(db, { ...stale }, 5_000);

    // Absolute-set semantics on the FIRST write — an `increment` capped from a
    // stale read is the old defect, and it could sum past the share.
    expect(dataOf(updateMany, 0)).toEqual({ refundedAmountPaise: 5_000 });
    expect(a).toMatchObject({ reversedPaise: 5_000, lostRace: false });

    // The loser re-reads and takes only the residual: 5_000 + min(5_000, 3_000).
    expect(b).toMatchObject({
      reversedPaise: 3_000,
      refundedAmountPaise: 8_000,
      fullyRefunded: true,
      lostRace: true,
    });
    // THREE calls, not two: B's REFUSED first attempt is itself an
    // `updateMany` — the conditional write that matched nothing. So the retry
    // that carries the residual is index 2. (The 8_000/8_000 case above sees
    // only two because there B's retry short-circuits at `take <= 0` and never
    // issues a third write.)
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(dataOf(updateMany, 2)).toEqual({
      refundedAmountPaise: 8_000,
      status: EarningStatus.REFUNDED,
    });
    expect(r.refundedAmountPaise).toBe(8_000);
    expect(r.refundedAmountPaise).toBeLessThanOrEqual(r.orgSharePaise);
  });

  it("never writes an increment on either rail — a two-writer sum cannot pass the share", async () => {
    const org = orgRow();
    const { db: odb, updateMany: oUpdate } = orgStore([org]);
    await applyCappedOrgEarningReversal(odb, { ...org }, 5_000);
    await applyCappedOrgEarningReversal(odb, { ...org }, 5_000);

    const cons: ConsRow = {
      id: "ce-1",
      status: EarningStatus.READY,
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
    };
    const { db: cdb, updateMany: cUpdate } = consStore([cons]);
    await applyCappedEarningReversal(cdb, { ...cons }, 5_000);
    await applyCappedEarningReversal(cdb, { ...cons }, 5_000);

    for (const m of [oUpdate, cUpdate]) {
      for (const [args] of m.mock.calls) {
        const data = (args as { data: Record<string, unknown> }).data;
        for (const v of Object.values(data)) {
          expect(typeof v).not.toBe("object"); // no { increment } / { decrement }
        }
      }
    }
    // Both compose to exactly the share, never 10_000.
    expect(org.refundedAmountPaise).toBe(8_000);
    expect(cons.refundedShareAmount).toBe(8_000);
  });

  it("never lets a request past the share, even against a partly-reversed row", async () => {
    const r = orgRow({ orgSharePaise: 3_000, refundedAmountPaise: 1_000 });
    const { db, updateMany } = orgStore([r]);

    const out = await applyCappedOrgEarningReversal(db, { ...r }, 3_000);

    expect(out).toMatchObject({
      reversedPaise: 2_000,
      refundedAmountPaise: 3_000,
    });
    expect(dataOf(updateMany)).toEqual({
      refundedAmountPaise: 3_000,
      status: EarningStatus.REFUNDED,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. PAID — the org rail's force equivalent — and the terminal row
// ---------------------------------------------------------------------------

describe("org capped earning reversal — PAID, and the terminal row", () => {
  it("PAID still moves to REFUNDED: on the org rail, being a legal SOURCE is the force equivalent", async () => {
    // The consultant arm gates a PAID row behind `refundEarnings(forceRefund)`.
    // The org twins never had that gate — `assertEarningStatusTransitionLegal`
    // permits PAID → REFUNDED, and a paid-out host share is recovered through the
    // COMPLETED-payout clawback in the CALLER. That behaviour is preserved
    // exactly: PAID stays in the org WHERE, and the reversal lands.
    const r = orgRow({ status: EarningStatus.PAID });
    const { db, updateMany } = orgStore([r]);

    const out = await applyCappedOrgEarningReversal(db, { ...r }, 8_000);

    expect(whereOf(updateMany).status).toBe(EarningStatus.PAID);
    expect(out).toMatchObject({
      reversedPaise: 8_000,
      refundedAmountPaise: 8_000,
      fullyRefunded: true,
    });
    expect(dataOf(updateMany)).toEqual({
      refundedAmountPaise: 8_000,
      status: EarningStatus.REFUNDED,
    });
    expect(r.status).toBe(EarningStatus.REFUNDED);
  });

  it("a PAID row that is NOT exhausted keeps PAID and does not throw", async () => {
    // The guard only fires when this call actually moves the status, so a
    // partial clawback of paid money stays legal on the same footing as the
    // consultant twin.
    const r = orgRow({
      status: EarningStatus.PAID,
      refundedAmountPaise: 5_000,
    });
    const { db, updateMany } = orgStore([r]);

    const out = await applyCappedOrgEarningReversal(db, { ...r }, 2_000);

    expect(out).toMatchObject({ reversedPaise: 2_000, fullyRefunded: false });
    expect(dataOf(updateMany)).toEqual({ refundedAmountPaise: 7_000 });
    expect(r.status).toBe(EarningStatus.PAID);
  });

  it("the terminal REFUNDED row is refused BEFORE any write, even with headroom", async () => {
    // Headroom on purpose: with the row already at its share the CAP zeroes the
    // request and the status predicate is never reached — a different (also
    // correct) outcome that would prove nothing here.
    const r = orgRow({
      status: EarningStatus.REFUNDED,
      refundedAmountPaise: 2_000,
    });
    const { db, updateMany } = orgStore([r]);

    await expect(
      applyCappedOrgEarningReversal(db, { ...r }, 8_000),
    ).rejects.toThrow(IllegalEarningStatusTransitionError);
    expect(updateMany).not.toHaveBeenCalled();
    expect(r.refundedAmountPaise).toBe(2_000);
  });

  it("states the org legal sources explicitly rather than aliasing the consultant set", () => {
    // Same enum, same six non-terminal states — but the org array is its own
    // declaration, so a future divergence is a diff here, not a silent coupling.
    expect(REFUNDABLE_ORG_EARNING_SOURCE).toEqual(REFUNDABLE_EARNING_SOURCE);
    expect(REFUNDABLE_ORG_EARNING_SOURCE).not.toContain(EarningStatus.REFUNDED);
    expect(REFUNDABLE_ORG_EARNING_SOURCE).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 4. A zero outcome means "post nothing"
// ---------------------------------------------------------------------------

describe("org capped earning reversal — zero never reaches the journal", () => {
  it("a row already at its share is a no-op with no CAS and no lost race", async () => {
    const r = orgRow({ refundedAmountPaise: 8_000 });
    const { db, updateMany } = orgStore([r]);

    const out = await applyCappedOrgEarningReversal(db, { ...r }, 8_000);

    expect(out).toMatchObject({
      reversedPaise: 0,
      refundedAmountPaise: 8_000,
      fullyRefunded: true,
      // FALSE, correctly: nobody won anything, there was simply nothing to take.
      lostRace: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("two refusals in a row report zero rather than claiming a write", async () => {
    const r = orgRow();
    const { db, updateMany } = orgStore([r], true);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const out = await applyCappedOrgEarningReversal(db, { ...r }, 1_000);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ reversedPaise: 0, lostRace: true });
    expect(r.refundedAmountPaise).toBe(0);
    // The org rail names ITSELF in the warning, so the log points at the twin.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Org earnings oe-1: capped reversal CAS refused twice",
      ),
    );
    warn.mockRestore();
  });

  it("a deleted row is a lost race, not a crash", async () => {
    const { db, updateMany, findUnique } = orgStore([]);
    findUnique.mockResolvedValueOnce(null as never);

    const out = await applyCappedOrgEarningReversal(db, orgRow(), 1_000);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ reversedPaise: 0, lostRace: true });
  });
});

// ---------------------------------------------------------------------------
// 5. The consultant path is unchanged by the generalisation
// ---------------------------------------------------------------------------

describe("the generalisation leaves the consultant rail alone", () => {
  it("keeps the consultant outcome shape and the consultant column names", async () => {
    const r: ConsRow = {
      id: "ce-1",
      status: EarningStatus.READY,
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
    };
    const { db, updateMany } = consStore([r]);

    const out = await applyCappedEarningReversal(db, { ...r }, 5_000);

    // The public shape `earnings-service.ts` (unreadable here, unchanged) reads.
    expect(Object.keys(out).sort()).toEqual([
      "fullyRefunded",
      "lostRace",
      "refundedShareAmount",
      "reversedPaise",
    ]);
    expect(out).toMatchObject({
      reversedPaise: 5_000,
      refundedShareAmount: 5_000,
      fullyRefunded: false,
      lostRace: false,
    });
    // The consultant column is pinned and written — the org names never leak in.
    expect(whereOf(updateMany).refundedShareAmount).toBe(0);
    expect(whereOf(updateMany).refundedAmountPaise).toBeUndefined();
    expect(dataOf(updateMany)).toEqual({ refundedShareAmount: 5_000 });
    expect(whereOf(updateMany).status).toBe(r.status);
  });

  it("the consultant guard still refuses the terminal row before any write", async () => {
    const r: ConsRow = {
      id: "ce-1",
      status: EarningStatus.REFUNDED,
      consultantSharePaise: 8_000,
      refundedShareAmount: 3_000,
    };
    const { db, updateMany } = consStore([r]);

    await expect(
      applyCappedEarningReversal(db, { ...r }, 5_000),
    ).rejects.toThrow(IllegalEarningStatusTransitionError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("the consultant double-refusal warning is unchanged on its own rail", async () => {
    const r: ConsRow = {
      id: "ce-1",
      status: EarningStatus.READY,
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
    };
    const { db } = consStore([r], true);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await applyCappedEarningReversal(db, { ...r }, 1_000);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Earnings ce-1: capped reversal CAS refused twice",
      ),
    );
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. ONE copy of the CAS logic survives
// ---------------------------------------------------------------------------

describe("one copy of the CAS logic survives the generalisation", () => {
  const read = (rel: string) =>
    readFileSync(join(__dirname, "..", "..", rel), "utf8");
  /**
   * Source with comments stripped. The docblocks QUOTE the predicates they
   * describe, so counting them in raw source would count the explanation too —
   * and a "structural" guard that is off by one because of a docblock is worse
   * than none.
   */
  const codeOf = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("both rails share one CAS core and never increment", () => {
    const code = codeOf("lib/payments/payouts/earning-reversal-cas.ts");
    // One typed conditional write per table, both driven by the one core.
    expect(code.match(/\.updateMany\(/g) ?? []).toHaveLength(2);
    expect(code).not.toMatch(/increment:/);
    expect(code).not.toMatch(/as unknown as/);
    expect(code).toMatch(/async function applyCappedReversal\(/);
    expect(code.match(/await applyCappedReversal\(/g) ?? []).toHaveLength(2);
  });

  it("neither refund front door writes an earning row with a bare update any more", () => {
    for (const rel of [
      "lib/payments/operations/refund.ts",
      "lib/payments/operations/booking-refund.ts",
    ]) {
      const code = codeOf(rel);
      // The old shape: `tx.organizationEarnings.update({ where: { id } })` — no
      // status predicate, no pinned amount, no cap re-derivation.
      expect(code).not.toMatch(/Earnings\.update\(\{/);
      expect(code).not.toMatch(/Earnings\.updateMany\(\{/); // the CAS owns the write
      // …and both sites go through the shared writer.
      expect(code).toMatch(/applyCappedEarningReversal/);
      expect(code).toMatch(/applyCappedOrgEarningReversal/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. End-to-end through the free-credit rail: a refused org CAS posts nothing
// ---------------------------------------------------------------------------

/** ₹1,000 + ₹180 GST booking, fully covered by referral credits, org-only. */
function orgOnlySettlement(rows: OrgRow[]) {
  return {
    originalAmount: 100_000,
    taxAmount: 18_000,
    legs: [{ source: "REFERRAL_CREDIT", amountPaise: 118_000 }],
    earnings: [],
    organizationEarnings: rows,
  };
}

function sum(
  postings: Array<{ direction: string; amountPaise: number }>,
  d: string,
) {
  return postings
    .filter((p) => p.direction === d)
    .reduce((s, p) => s + p.amountPaise, 0);
}

function lastPosting(): any[] {
  const calls = mockPostLedgerTxn.mock.calls;
  return calls[calls.length - 1]?.[1]?.postings ?? [];
}

function clawbackPosts() {
  return mockPostLedgerTxn.mock.calls.filter(
    ([, arg]: [unknown, { idempotencyKey: string }]) =>
      String(arg?.idempotencyKey).startsWith("clawback:"),
  );
}

function noZeroAmountPosting() {
  for (const call of mockPostLedgerTxn.mock.calls) {
    for (const p of call[1].postings) {
      expect(Number.isInteger(p.amountPaise)).toBe(true);
      expect(p.amountPaise).toBeGreaterThan(0);
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  tx.refund.findFirst.mockResolvedValue(null);
  tx.refund.create.mockResolvedValue({ id: "refund-row-1" });
  mockReverseCredits.mockResolvedValue(118_000);
  mockReverseUtilization.mockResolvedValue(undefined);
  // One object serves both reads: the rail probe takes only `paymentIntent`,
  // the settlement read takes the rest. (A `mockResolvedValueOnce` here would
  // queue an entry per beforeEach and every later test would drain a stale
  // intent-only row.)
  mockPaymentFindUnique.mockResolvedValue({
    paymentIntent: "free_1730000000_abc",
    id: PAYMENT_ID,
    userId: "user-1",
    organizationId: null,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentGateway: "RAZORPAY",
  });
});

describe("free_ credits rail — the org clawback reads the APPLIED amount", () => {
  it("claws back exactly what the CAS applied, and balances the journal", async () => {
    const r = orgRow({
      status: EarningStatus.PAID,
      orgSharePaise: 20_000,
      orgPayoutId: "opayout-7",
      orgPayout: { status: "COMPLETED", clawbackInitiatedAt: null },
    });
    const d = makeDelegate([r], "refundedAmountPaise");
    tx.organizationEarnings.updateMany = d.updateMany;
    tx.organizationEarnings.findUnique = d.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(orgOnlySettlement([r]));

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // The row landed at its share via the CAS (absolute set, not an increment).
    expect(r.refundedAmountPaise).toBe(20_000);
    expect(r.status).toBe(EarningStatus.REFUNDED);
    expect(d.updateMany.mock.calls[0][0].data).toEqual({
      refundedAmountPaise: 20_000,
      status: EarningStatus.REFUNDED,
    });
    // The payout counter took the APPLIED figure.
    const clawback = tx.organizationPayout.update.mock.calls.find(
      ([arg]: any) => !!arg?.data?.clawbackAmountPaise,
    );
    expect(clawback?.[0].data.clawbackAmountPaise).toEqual({
      increment: 20_000,
    });
    // …and so did the audit row and the clawback journal, exactly once.
    expect(tx.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: expect.objectContaining({ amountPaise: 20_000 }),
        }),
      }),
    );
    expect(clawbackPosts()).toHaveLength(1);
    expect(clawbackPosts()[0][1].idempotencyKey).toBe(
      "clawback:refund-row-1:opayout-7",
    );
    // The ORG_PAYABLE debit matches the applied figure, and the txn still balances.
    const payable = lastPosting().find(
      (p: any) => p.account.kind === "ORG_PAYABLE" && p.direction === "DEBIT",
    );
    expect(payable).toMatchObject({ amountPaise: 20_000 });
    expect(sum(lastPosting(), "DEBIT")).toBe(sum(lastPosting(), "CREDIT"));
    noZeroAmountPosting();
  });

  it("posts NO clawback and no payable debit when the org CAS is refused twice", async () => {
    const r = orgRow({
      status: EarningStatus.READY,
      orgSharePaise: 20_000,
      orgPayoutId: "opayout-7",
      orgPayout: { status: "COMPLETED", clawbackInitiatedAt: null },
    });
    const d = makeDelegate([r], "refundedAmountPaise", true);
    tx.organizationEarnings.updateMany = d.updateMany;
    tx.organizationEarnings.findUnique = d.findUnique;
    tx.payment.findUniqueOrThrow.mockResolvedValue(orgOnlySettlement([r]));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Both attempts ran, neither won — a reported no-op, never a claimed write.
    expect(d.updateMany).toHaveBeenCalledTimes(2);
    expect(r.refundedAmountPaise).toBe(0);
    // Nothing was clawed back, so nothing may be claimed to have been. A
    // 0-paise `postLedgerTxn` would THROW ("each posting must be a positive
    // integer paise"), so "post nothing" has to mean an ABSENT posting.
    expect(tx.organizationPayout.update).not.toHaveBeenCalled();
    expect(tx.orgAuditLog.create).not.toHaveBeenCalled();
    expect(clawbackPosts()).toHaveLength(0);
    expect(
      lastPosting().find(
        (p: any) => p.account.kind === "ORG_PAYABLE" && p.direction === "DEBIT",
      ),
    ).toBeUndefined();
    // The funding return is still journalled — the credits really came back —
    // so the txn balances with the whole amount as the fee residual.
    expect(sum(lastPosting(), "DEBIT")).toBe(sum(lastPosting(), "CREDIT"));
    expect(
      lastPosting().find((p: any) => p.account.kind === "PLATFORM_FEE"),
    ).toMatchObject({ direction: "DEBIT", amountPaise: 100_000 });
    noZeroAmountPosting();
    warn.mockRestore();
  });
});
