/** @jest-environment node */
import { txDouble } from "../fixtures/tx-double";
import {
  oldestUnrecoveredAt,
  staleClawbackFindings,
} from "../../scripts/reconcile/tax-and-clawback-steps";

const NOW = new Date("2026-10-23T12:00:00Z");
const OLD = new Date("2026-06-01T12:00:00Z");
const RECENT = new Date("2026-10-20T12:00:00Z");

it.each(["ORG", "CONSULTANT"] as const)(
  "keeps a %s clawback void when its originating payout has reversed",
  async (rail) => {
    const owedDirection = rail === "ORG" ? "CREDIT" : "DEBIT";
    const voidDirection = rail === "ORG" ? "DEBIT" : "CREDIT";
    const account =
      rail === "ORG"
        ? { organizationId: "org-1", consultantProfileId: null }
        : { consultantProfileId: "consultant-1", organizationId: null };
    const entries = [
      {
        direction: owedDirection,
        amountPaise: 1000,
        createdAt: OLD,
        account,
        transaction: {
          idempotencyKey: "clawback:refund-1:payout-1",
          payoutId: "payout-1",
        },
      },
      {
        direction: voidDirection,
        amountPaise: 1000,
        createdAt: RECENT,
        account,
        transaction: {
          idempotencyKey: "clawback-void:clawback:refund-1:payout-1",
          payoutId: "payout-1",
        },
      },
    ];
    const db = txDouble({
      ledgerEntry: { findMany: jest.fn(async () => entries) },
      organizationPayout: {
        findMany: jest.fn(async () => [{ id: "payout-1" }]),
      },
      consultantPayout: { findMany: jest.fn(async () => [{ id: "payout-1" }]) },
    });
    expect(
      await staleClawbackFindings(
        NOW,
        rail === "ORG" ? "org-1" : undefined,
        db,
      ),
    ).toEqual([]);
  },
);

it("voiding a newer origin cannot hide an older outstanding clawback", () => {
  const events: Parameters<typeof oldestUnrecoveredAt>[0] = [
    {
      payeeId: "org-1",
      kind: "OWED",
      paise: 1000,
      at: OLD,
      payoutId: "older-payout",
      idempotencyKey: "clawback:older",
    },
    {
      payeeId: "org-1",
      kind: "OWED",
      paise: 1000,
      at: RECENT,
      payoutId: "newer-payout",
      idempotencyKey: "clawback:newer",
    },
    {
      payeeId: "org-1",
      kind: "VOIDED",
      paise: 1000,
      at: NOW,
      payoutId: "newer-payout",
      idempotencyKey: "clawback-void:clawback:newer",
    },
  ];
  expect(oldestUnrecoveredAt(events)).toEqual(OLD);
});

it("still ignores a lapsed collection while preserving the voided portion of its origin", async () => {
  const account = { organizationId: "org-1", consultantProfileId: null };
  const entries = [
    {
      direction: "CREDIT",
      amountPaise: 1000,
      createdAt: OLD,
      account,
      transaction: { idempotencyKey: "clawback:origin", payoutId: "origin" },
    },
    {
      direction: "DEBIT",
      amountPaise: 250,
      createdAt: RECENT,
      account,
      transaction: {
        idempotencyKey: "clawback-void:clawback:origin",
        payoutId: "origin",
      },
    },
    {
      direction: "DEBIT",
      amountPaise: 250,
      createdAt: RECENT,
      account,
      transaction: {
        idempotencyKey: "clawback-recovery:collection",
        payoutId: "collection",
      },
    },
  ];
  const db = txDouble({
    ledgerEntry: { findMany: jest.fn(async () => entries) },
    organizationPayout: {
      findMany: jest.fn(async () => [{ id: "origin" }, { id: "collection" }]),
    },
  });
  expect(await staleClawbackFindings(NOW, "org-1", db)).toEqual([
    expect.objectContaining({
      kind: "CLAWBACK_RECEIVABLE_STALE",
      actualPaise: 750,
      deltaPaise: 750,
    }),
  ]);
});
