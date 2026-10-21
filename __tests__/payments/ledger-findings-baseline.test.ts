/**
 * @jest-environment node
 */

/**
 * The ledger reconciler gates on a checked-in baseline of known findings.
 *
 * The baseline pins each known finding by fingerprint (kind, delta, the entity
 * ids the finding carries and, where that is all it has, one `details` key),
 * so a NEW row or a NEW amount is never excused. Every entry carries an owner,
 * a reason and an expiry: an expired entry excuses nothing, and a malformed
 * entry is ignored AND fails the run, so a broken baseline can never green it.
 */

import {
  evaluateLedgerBaseline,
  LEDGER_FINDINGS_BASELINE,
  type LedgerBaselineEntry,
} from "../../scripts/reconcile/ledger-findings-baseline";
import {
  RECONCILE_FINDING_KINDS,
  type Finding,
} from "../../scripts/reconcile/reconcile-ledgers";

const NOW = new Date("2026-10-21T09:00:00.000Z");

const walletDrift = (over: Partial<Finding> = {}): Finding => ({
  kind: "WALLET_BALANCE_DRIFT",
  organizationId: "org_1",
  billingAccountId: "acct_1",
  expectedPaise: 1_000,
  actualPaise: 1_100,
  deltaPaise: 100,
  ...over,
});

const entry = (
  over: Partial<LedgerBaselineEntry> = {},
): LedgerBaselineEntry => ({
  kind: "WALLET_BALANCE_DRIFT",
  organizationId: "org_1",
  billingAccountId: "acct_1",
  deltaPaise: 100,
  owner: "finance",
  reason: "seeded demo row",
  expires: "2026-12-15",
  ...over,
});

describe("evaluateLedgerBaseline", () => {
  it("baselines a finding the entry pins and lets the run pass", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift()],
      entries: [entry()],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.baselinedCount).toBe(1);
    expect(evaluation.unbaselinedCount).toBe(0);
    expect(evaluation.problems).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it("does not baseline a finding whose delta changed and fails the run", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift({ deltaPaise: 101 })],
      entries: [entry()],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.baselinedCount).toBe(0);
    expect(evaluation.unbaselinedCount).toBe(1);
    expect(evaluation.ok).toBe(false);
  });

  it("does not baseline a finding on a row the entry does not pin", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift({ billingAccountId: "acct_2" })],
      entries: [entry()],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.unbaselinedCount).toBe(1);
    expect(evaluation.ok).toBe(false);
  });

  it("does not baseline a finding that carries an identifier the entry omits", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift()],
      entries: [entry({ organizationId: undefined })],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.unbaselinedCount).toBe(1);
    expect(evaluation.ok).toBe(false);
  });

  it("baselines on the pinned details key when the finding has no other id", () => {
    const refundCoherence: Finding = {
      kind: "REFUND_BOOKING_COHERENCE",
      paymentId: "pay_1",
      expectedPaise: 0,
      actualPaise: 231_305,
      deltaPaise: 231_305,
      details: { bookingUtilizationId: "bu_1", unit: "paise" },
    };

    const matched = evaluateLedgerBaseline({
      findings: [refundCoherence],
      entries: [
        entry({
          kind: "REFUND_BOOKING_COHERENCE",
          organizationId: undefined,
          billingAccountId: undefined,
          paymentId: "pay_1",
          deltaPaise: 231_305,
          detail: { key: "bookingUtilizationId", value: "bu_1" },
        }),
      ],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });
    expect(matched.baselinedCount).toBe(1);
    expect(matched.ok).toBe(true);

    const otherUtilization = evaluateLedgerBaseline({
      findings: [refundCoherence],
      entries: [
        entry({
          kind: "REFUND_BOOKING_COHERENCE",
          organizationId: undefined,
          billingAccountId: undefined,
          paymentId: "pay_1",
          deltaPaise: 231_305,
          detail: { key: "bookingUtilizationId", value: "bu_2" },
        }),
      ],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });
    expect(otherUtilization.unbaselinedCount).toBe(1);
    expect(otherUtilization.ok).toBe(false);
  });

  it("does not baseline through an expired entry", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift()],
      entries: [entry({ expires: "2026-10-20" })],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.baselinedCount).toBe(0);
    expect(evaluation.unbaselinedCount).toBe(1);
    expect(evaluation.expiredEntryCount).toBe(1);
    // An expired entry is a legitimate state, not a broken baseline.
    expect(evaluation.problems).toEqual([]);
    expect(evaluation.ok).toBe(false);
  });

  it("fails the run and reports a malformed entry", () => {
    const missingOwner = evaluateLedgerBaseline({
      findings: [],
      entries: [
        {
          kind: "WALLET_BALANCE_DRIFT",
          deltaPaise: 100,
          reason: "seeded demo row",
          expires: "2026-12-15",
        },
      ],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(missingOwner.problems).toHaveLength(1);
    expect(missingOwner.problems[0]).toContain("owner");
    expect(missingOwner.ok).toBe(false);
  });

  it("fails the run and reports a malformed expiry date", () => {
    const badDate = evaluateLedgerBaseline({
      findings: [],
      entries: [entry({ expires: "2026-13-45" })],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(badDate.problems).toHaveLength(1);
    expect(badDate.problems[0]).toContain("expires");
    expect(badDate.ok).toBe(false);
  });

  it("fails the run and reports an unknown finding kind", () => {
    const unknownKind = evaluateLedgerBaseline({
      findings: [],
      entries: [
        {
          kind: "NOT_A_FINDING_KIND",
          deltaPaise: 100,
          owner: "finance",
          reason: "seeded demo row",
          expires: "2026-12-15",
        },
      ],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(unknownKind.problems).toHaveLength(1);
    expect(unknownKind.problems[0]).toContain("NOT_A_FINDING_KIND");
    expect(unknownKind.ok).toBe(false);
  });

  it("does not baseline the surplus when the entry allows fewer occurrences", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift(), walletDrift()],
      entries: [entry({ occurrences: 1 })],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.baselinedCount).toBe(1);
    expect(evaluation.unbaselinedCount).toBe(1);
    expect(evaluation.ok).toBe(false);
  });

  it("baselines every occurrence the entry allows", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [walletDrift(), walletDrift()],
      entries: [entry({ occurrences: 2 })],
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.baselinedCount).toBe(2);
    expect(evaluation.unbaselinedCount).toBe(0);
    expect(evaluation.ok).toBe(true);
  });
});

describe("the checked-in baseline", () => {
  it("is well formed and names only kinds the auditor can raise", () => {
    const evaluation = evaluateLedgerBaseline({
      findings: [],
      entries: LEDGER_FINDINGS_BASELINE,
      knownKinds: RECONCILE_FINDING_KINDS,
      now: NOW,
    });

    expect(evaluation.problems).toEqual([]);
    expect(evaluation.ok).toBe(true);
  });

  it("pins the seeded demo findings by fingerprint", () => {
    const seeded: Array<Partial<LedgerBaselineEntry> & { kind: string }> = [
      {
        kind: "WALLET_BALANCE_DRIFT",
        organizationId: "cmu15uwqp03rzc7yog53t9fnn",
        billingAccountId: "969f23c5-7656-415d-b527-4030a4eff58e",
        deltaPaise: 570_036,
      },
      {
        kind: "REFUND_BOOKING_COHERENCE",
        paymentId: "7d747d97-efa6-4bef-9857-8453a5798330",
        deltaPaise: 231_305,
      },
      {
        kind: "EARNINGS_LEDGER_DRIFT",
        paymentId: "81ec1be6-0e84-4a6a-9e9a-b5799379d857",
        deltaPaise: 32_000_000,
      },
      {
        kind: "SPLIT_SUM_MISMATCH",
        paymentId: "81ec1be6-0e84-4a6a-9e9a-b5799379d857",
        deltaPaise: 32_000_000,
      },
    ];

    for (const pin of seeded) {
      const matching = LEDGER_FINDINGS_BASELINE.filter(
        (e) =>
          e.kind === pin.kind &&
          e.deltaPaise === pin.deltaPaise &&
          (pin.organizationId === undefined ||
            e.organizationId === pin.organizationId) &&
          (pin.billingAccountId === undefined ||
            e.billingAccountId === pin.billingAccountId) &&
          (pin.paymentId === undefined || e.paymentId === pin.paymentId),
      );
      expect(matching).toHaveLength(1);
    }
  });
});
