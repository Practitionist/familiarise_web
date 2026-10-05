/**
 * Recovers post-payout clawbacks from the payee's next payouts.
 *
 * A refund or lost dispute that lands after a payee was paid leaves them owing
 * the platform: on the consultant rail that balance sits on
 * CONSULTANT_RECEIVABLE, on the org rail it is the net of the `clawback:*`
 * journals on the org's ORG_PAYABLE (those journals book the amount against
 * CASH). When a payout is built, the outstanding balance is netted from it,
 * the remainder carries to the next payout, and the TDS base is untouched:
 * the payout row keeps its gross amount and the recovery lives only in the
 * ledger, under one key per payout.
 *
 * A recovery attached to a payout that later fails, is cancelled or is
 * reversed is released (re-opened) when the payee's next payout is built.
 */

import { PayoutStatus } from "@prisma/client";
import type { PrismaLike, Tx } from "@/lib/prisma";
import { PAN_FALLBACK_BPS } from "@/lib/compliance/tds";
import {
  ledgerAccountId,
  ledgerBalancePaise,
  postLedgerTxn,
  type AccountRef,
  type Posting,
} from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";

export const CLAWBACK_RECOVERY_KEY_PREFIX = "clawback-recovery:";
export const CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX =
  "clawback-recovery-release:";

/** Payout statuses whose recovery no longer stands. */
export const RECOVERY_RELEASING_STATUSES: PayoutStatus[] = [
  PayoutStatus.FAILED,
  PayoutStatus.CANCELLED,
  PayoutStatus.REVERSED,
];

export type ClawbackPayee =
  | { rail: "CONSULTANT"; consultantProfileId: string }
  | { rail: "ORG"; organizationId: string };

export function clawbackRecoveryKey(payoutId: string): string {
  return `${CLAWBACK_RECOVERY_KEY_PREFIX}${payoutId}`;
}

export function clawbackRecoveryReleaseKey(payoutId: string): string {
  return `${CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX}${payoutId}`;
}

function payableAccount(payee: ClawbackPayee): AccountRef {
  return payee.rail === "CONSULTANT"
    ? {
        kind: "CONSULTANT_PAYABLE",
        consultantProfileId: payee.consultantProfileId,
      }
    : { kind: "ORG_PAYABLE", organizationId: payee.organizationId };
}

/** The account a recovery credits: the consultant receivable, or CASH where the org clawback booked it. */
function receivableAccount(payee: ClawbackPayee): AccountRef {
  return payee.rail === "CONSULTANT"
    ? {
        kind: "CONSULTANT_RECEIVABLE",
        consultantProfileId: payee.consultantProfileId,
      }
    : { kind: "CASH" };
}

/** The payee-scoped account every recovery and release touches. */
function payeeLedgerAccountId(payee: ClawbackPayee): string {
  return ledgerAccountId(
    payee.rail === "CONSULTANT"
      ? receivableAccount(payee)
      : payableAccount(payee),
  );
}

/** Paise the payee still owes back, read from the ledger; never negative. */
export async function outstandingClawbackPaise(
  db: PrismaLike,
  payee: ClawbackPayee,
): Promise<number> {
  if (payee.rail === "CONSULTANT") {
    return Math.max(0, await ledgerBalancePaise(db, receivableAccount(payee)));
  }
  const rows = await db.ledgerEntry.groupBy({
    by: ["direction"],
    where: {
      accountId: ledgerAccountId(payableAccount(payee)),
      transaction: { idempotencyKey: { startsWith: "clawback" } },
    },
    _sum: { amountPaise: true },
  });
  let owed = 0;
  for (const r of rows) {
    const paise = sumPaise(r._sum.amountPaise);
    owed += r.direction === "CREDIT" ? paise : -paise;
  }
  return Math.max(0, owed);
}

/**
 * The most a payout of `payablePaise` may give up to recovery: it always keeps
 * the payout minimum plus room for the highest withholding rate, so the cash
 * leg can never go negative once TDS is applied.
 */
export function recoverablePaise(
  payablePaise: number,
  minimumPayoutPaise: number,
  withholdingKnown: boolean,
): number {
  const withholdingRoom = withholdingKnown
    ? 0
    : Math.ceil((payablePaise * PAN_FALLBACK_BPS) / 10_000);
  return Math.max(0, payablePaise - minimumPayoutPaise - withholdingRoom);
}

/** Amount recovered on one payout, net of any release; 0 when none. */
export async function clawbackRecoveredPaise(
  db: PrismaLike,
  payoutId: string,
): Promise<number> {
  const txns = await db.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: [
          clawbackRecoveryKey(payoutId),
          clawbackRecoveryReleaseKey(payoutId),
        ],
      },
    },
    select: {
      idempotencyKey: true,
      entries: { where: { direction: "DEBIT" }, select: { amountPaise: true } },
    },
  });
  let recovered = 0;
  for (const t of txns) {
    const paise = t.entries.reduce((s, e) => s + sumPaise(e.amountPaise), 0);
    recovered +=
      t.idempotencyKey === clawbackRecoveryKey(payoutId) ? paise : -paise;
  }
  return Math.max(0, recovered);
}

async function postRecovery(
  tx: Tx,
  payee: ClawbackPayee,
  payoutId: string,
  amountPaise: number,
  release: boolean,
): Promise<void> {
  const payable: Posting = {
    account: payableAccount(payee),
    direction: release ? "CREDIT" : "DEBIT",
    amountPaise,
  };
  const receivable: Posting = {
    account: receivableAccount(payee),
    direction: release ? "DEBIT" : "CREDIT",
    amountPaise,
  };
  await postLedgerTxn(tx, {
    idempotencyKey: release
      ? clawbackRecoveryReleaseKey(payoutId)
      : clawbackRecoveryKey(payoutId),
    kind: payee.rail === "CONSULTANT" ? "PAYOUT" : "ORG_PAYOUT",
    payoutId,
    description: release
      ? `Clawback recovery released: payout ${payoutId} did not complete`
      : `Clawback recovered from payout ${payoutId}`,
    postings: [payable, receivable],
  });
}

/** Re-opens the recoveries of this payee's payouts that failed, were cancelled or were reversed. */
async function releaseLapsedRecoveries(
  tx: Tx,
  payee: ClawbackPayee,
): Promise<void> {
  const recoveries = await tx.ledgerTransaction.findMany({
    where: {
      idempotencyKey: { startsWith: CLAWBACK_RECOVERY_KEY_PREFIX },
      entries: { some: { accountId: payeeLedgerAccountId(payee) } },
    },
    select: {
      payoutId: true,
      entries: { where: { direction: "DEBIT" }, select: { amountPaise: true } },
    },
  });
  const byPayout = new Map<string, number>();
  for (const r of recoveries) {
    if (!r.payoutId) continue;
    byPayout.set(
      r.payoutId,
      r.entries.reduce((s, e) => s + sumPaise(e.amountPaise), 0),
    );
  }
  if (byPayout.size === 0) return;

  const released = await tx.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: [...byPayout.keys()].map(clawbackRecoveryReleaseKey),
      },
    },
    select: { payoutId: true },
  });
  for (const r of released) if (r.payoutId) byPayout.delete(r.payoutId);
  if (byPayout.size === 0) return;

  const where = {
    id: { in: [...byPayout.keys()] },
    status: { in: RECOVERY_RELEASING_STATUSES },
  };
  const lapsed =
    payee.rail === "CONSULTANT"
      ? await tx.consultantPayout.findMany({ where, select: { id: true } })
      : await tx.organizationPayout.findMany({ where, select: { id: true } });
  for (const { id } of lapsed) {
    await postRecovery(tx, payee, id, byPayout.get(id) ?? 0, true);
  }
}

/**
 * Nets the payee's outstanding clawback from a payout being built, inside its
 * creation transaction. Returns the paise recovered (0 when nothing is owed).
 */
export async function recoverClawbackOnPayout(
  tx: Tx,
  input: { payee: ClawbackPayee; payoutId: string; recoverablePaise: number },
): Promise<number> {
  await releaseLapsedRecoveries(tx, input.payee);
  if (input.recoverablePaise <= 0) return 0;
  const outstanding = await outstandingClawbackPaise(tx, input.payee);
  const recovered = Math.min(outstanding, input.recoverablePaise);
  if (recovered <= 0) return 0;
  await postRecovery(tx, input.payee, input.payoutId, recovered, false);
  return recovered;
}
