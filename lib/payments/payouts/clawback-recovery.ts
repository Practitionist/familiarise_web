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
 * reversed is released (re-opened) in the transaction that makes that move.
 */

import {
  PayoutStatus,
  type LedgerAccountKind,
  type LedgerDirection,
  type LedgerTransactionKind,
} from "@prisma/client";
import type { PrismaLike, Tx } from "@/lib/prisma";
import { PAN_FALLBACK_BPS } from "@/lib/compliance/tds";
import {
  ledgerAccountId,
  ledgerBalancePaise,
  postLedgerTxn,
  type AccountRef,
  type Posting,
} from "@/lib/payments/ledger/post";
import { prorate, sumPaise } from "@/lib/payments/utils/money";

/** The org clawback journal `clawback:<driver>:<payoutId>` written by the reversal engine. */
export const ORG_CLAWBACK_KEY_PREFIX = "clawback:";
export const CLAWBACK_RECOVERY_KEY_PREFIX = "clawback-recovery:";
export const CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX =
  "clawback-recovery-release:";
export const CLAWBACK_VOID_KEY_PREFIX = "clawback-void:";

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

/** Journals that move the org rail's clawback balance on ORG_PAYABLE. */
export const ORG_CLAWBACK_KEY_FILTER = {
  OR: [
    ORG_CLAWBACK_KEY_PREFIX,
    CLAWBACK_RECOVERY_KEY_PREFIX,
    CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX,
    CLAWBACK_VOID_KEY_PREFIX,
  ].map((prefix) => ({ idempotencyKey: { startsWith: prefix } })),
};

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
      transaction: ORG_CLAWBACK_KEY_FILTER,
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
    : prorate(payablePaise, PAN_FALLBACK_BPS, 10_000, "ceil");
  return Math.max(0, payablePaise - minimumPayoutPaise - withholdingRoom);
}

/** Amount recovered on each payout, net of any release; absent ids recovered nothing. */
export async function clawbackRecoveredByPayout(
  db: PrismaLike,
  payoutIds: string[],
): Promise<Map<string, number>> {
  const recovered = new Map<string, number>();
  if (payoutIds.length === 0) return recovered;
  const txns = await db.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: payoutIds.flatMap((id) => [
          clawbackRecoveryKey(id),
          clawbackRecoveryReleaseKey(id),
        ]),
      },
    },
    select: {
      idempotencyKey: true,
      payoutId: true,
      entries: { where: { direction: "DEBIT" }, select: { amountPaise: true } },
    },
  });
  for (const t of txns) {
    if (!t.payoutId) continue;
    const paise = t.entries.reduce((s, e) => s + sumPaise(e.amountPaise), 0);
    const signed = t.idempotencyKey.startsWith(
      CLAWBACK_RECOVERY_RELEASE_KEY_PREFIX,
    )
      ? -paise
      : paise;
    recovered.set(t.payoutId, (recovered.get(t.payoutId) ?? 0) + signed);
  }
  for (const [id, paise] of recovered) recovered.set(id, Math.max(0, paise));
  return recovered;
}

/** Amount recovered on one payout, net of any release; 0 when none. */
export async function clawbackRecoveredPaise(
  db: PrismaLike,
  payoutId: string,
): Promise<number> {
  return (await clawbackRecoveredByPayout(db, [payoutId])).get(payoutId) ?? 0;
}

const MIRRORED_TXN_SELECT = {
  idempotencyKey: true,
  kind: true,
  entries: {
    select: {
      direction: true,
      amountPaise: true,
      account: {
        select: {
          kind: true,
          organizationId: true,
          consultantProfileId: true,
        },
      },
    },
  },
} as const;

interface MirroredTxn {
  kind: LedgerTransactionKind;
  entries: Array<{
    direction: LedgerDirection;
    amountPaise: number | bigint;
    account: {
      kind: LedgerAccountKind;
      organizationId: string | null;
      consultantProfileId: string | null;
    };
  }>;
}

/** Every entry of `txn` with its direction flipped. */
function mirrorPostings(txn: MirroredTxn): Posting[] {
  return txn.entries.map((e): Posting => ({
    account: {
      kind: e.account.kind,
      organizationId: e.account.organizationId,
      consultantProfileId: e.account.consultantProfileId,
    },
    direction: e.direction === "DEBIT" ? "CREDIT" : "DEBIT",
    amountPaise: sumPaise(e.amountPaise),
  }));
}

/**
 * Re-opens the clawback recovered on a payout that did not complete, by
 * mirroring its recovery journal. Idempotent; a no-op when nothing was
 * recovered. Call in the transaction that moves the payout to FAILED,
 * CANCELLED or REVERSED, after any reversal journal that reads the recovery.
 */
export async function releaseClawbackRecovery(
  tx: PrismaLike,
  payoutId: string,
): Promise<void> {
  const txns = await tx.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: [
          clawbackRecoveryKey(payoutId),
          clawbackRecoveryReleaseKey(payoutId),
        ],
      },
    },
    select: MIRRORED_TXN_SELECT,
  });
  if (txns.length !== 1) return;
  const [recovery] = txns;
  if (recovery.idempotencyKey !== clawbackRecoveryKey(payoutId)) return;
  await postLedgerTxn(tx, {
    idempotencyKey: clawbackRecoveryReleaseKey(payoutId),
    kind: recovery.kind,
    payoutId,
    description: `Clawback recovery released: payout ${payoutId} did not complete`,
    postings: mirrorPostings(recovery),
  });
}

/** Entries that raise what the payee owes: receivable debits, or clawback-journal credits on ORG_PAYABLE. */
function owedRaisingEntries(payee: ClawbackPayee) {
  return payee.rail === "CONSULTANT"
    ? {
        accountId: ledgerAccountId(receivableAccount(payee)),
        direction: "DEBIT" as const,
      }
    : {
        accountId: ledgerAccountId(payableAccount(payee)),
        direction: "CREDIT" as const,
        transaction: ORG_CLAWBACK_KEY_FILTER,
      };
}

/**
 * Voids the still-unrecovered part of each clawback raised against a payout
 * the bank returned: its earnings reopen net of the refund, so that part would
 * net twice. Later payouts are taken to recover the oldest debts first.
 * Returns what is voided and what had already been recovered and stays booked.
 */
export async function voidClawbacksRaisedOnPayout(
  tx: PrismaLike,
  input: { payoutId: string } & (
    { consultantProfileId: string } | { organizationId: string }
  ),
): Promise<{ voidedPaise: number; alreadyRecoveredPaise: number }> {
  const { payoutId } = input;
  const raised = await tx.ledgerTransaction.findMany({
    where: {
      payoutId,
      idempotencyKey: { startsWith: ORG_CLAWBACK_KEY_PREFIX },
    },
    select: { id: true, ...MIRRORED_TXN_SELECT },
  });
  if (raised.length === 0) return { voidedPaise: 0, alreadyRecoveredPaise: 0 };

  const payee: ClawbackPayee =
    "consultantProfileId" in input
      ? { rail: "CONSULTANT", consultantProfileId: input.consultantProfileId }
      : { rail: "ORG", organizationId: input.organizationId };
  const balance = await outstandingClawbackPaise(tx, payee);
  const debits = await tx.ledgerEntry.findMany({
    where: owedRaisingEntries(payee),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { transactionId: true, amountPaise: true },
  });

  let voidedPaise = 0;
  let alreadyRecoveredPaise = 0;
  for (const txn of raised) {
    const at = debits.findIndex((d) => d.transactionId === txn.id);
    const raisedPaise = at === -1 ? 0 : sumPaise(debits[at].amountPaise);
    const laterPaise = debits
      .slice(at + 1)
      .reduce((s, d) => s + sumPaise(d.amountPaise), 0);
    const uniform = txn.entries.every(
      (e) => sumPaise(e.amountPaise) === raisedPaise,
    );
    const voidPaise = uniform
      ? Math.min(raisedPaise, Math.max(0, balance - laterPaise))
      : 0;
    alreadyRecoveredPaise += raisedPaise - voidPaise;
    if (voidPaise <= 0) continue;
    voidedPaise += voidPaise;
    await postLedgerTxn(tx, {
      idempotencyKey: `${CLAWBACK_VOID_KEY_PREFIX}${txn.idempotencyKey}`,
      kind: txn.kind,
      payoutId,
      description: `Clawback voided: payout ${payoutId} was reversed by the bank`,
      postings: mirrorPostings(txn).map((p) => ({
        ...p,
        amountPaise: voidPaise,
      })),
    });
  }
  return { voidedPaise, alreadyRecoveredPaise };
}

/**
 * Nets the payee's outstanding clawback from a payout being built, inside its
 * creation transaction. Returns the paise recovered (0 when nothing is owed).
 */
export async function recoverClawbackOnPayout(
  tx: Tx,
  input: { payee: ClawbackPayee; payoutId: string; recoverablePaise: number },
): Promise<number> {
  if (input.recoverablePaise <= 0) return 0;
  const outstanding = await outstandingClawbackPaise(tx, input.payee);
  const recovered = Math.min(outstanding, input.recoverablePaise);
  if (recovered <= 0) return 0;
  await postLedgerTxn(tx, {
    idempotencyKey: clawbackRecoveryKey(input.payoutId),
    kind: input.payee.rail === "CONSULTANT" ? "PAYOUT" : "ORG_PAYOUT",
    payoutId: input.payoutId,
    description: `Clawback recovered from payout ${input.payoutId}`,
    postings: [
      {
        account: payableAccount(input.payee),
        direction: "DEBIT",
        amountPaise: recovered,
      },
      {
        account: receivableAccount(input.payee),
        direction: "CREDIT",
        amountPaise: recovered,
      },
    ],
  });
  return recovered;
}
