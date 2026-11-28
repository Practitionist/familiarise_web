import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import type { PrismaLike } from "@/lib/prisma";
import { isWriteConflict } from "@/lib/db/pg-errors";
/**
 * #771 D1/D5 — double-entry posting helper (Batch 2 foundation).
 *
 * Every cash event posts ONE balanced LedgerTransaction: Σ(DEBIT) == Σ(CREDIT),
 * all amounts positive paise. Balances are DERIVED via `ledgerBalancePaise()` —
 * never stored, so postings to shared accounts (CASH, GST_PAYABLE) write no
 * common row and never serialize each other. `BillingAccount.walletBalance` survives only as a cache for the
 * atomic-debit guard, asserted against balance(WALLET) by the reconcile cron.
 *
 * Accounts resolve on demand to a DETERMINISTIC id
 * (`<kind>|<orgId|_>|<membershipId|_>|<currency>`) so concurrent posts to the
 * same scope dedupe on the primary key — sidestepping the Postgres
 * nullable-unique gotcha (a unique index does not dedupe NULLs).
 *
 * Idempotency: `LedgerTransaction.idempotencyKey` is `@unique`; a retry with the
 * same key is a no-op. Safe to call inside an existing `$transaction` (pass the
 * tx client). Chart of accounts + per-flow postings: see
 * `docs/finance/20-ledger/02-chart-of-accounts.md` + `docs/finance/20-ledger/04-postings.md`.
 */
import type {
  Currency,
  LedgerAccountKind,
  LedgerDirection,
  LedgerTransactionKind,
} from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";

export interface AccountRef {
  kind: LedgerAccountKind;
  /** Org-scoped accounts (WALLET, ORG_PAYABLE, ORG_RECEIVABLE). */
  organizationId?: string | null;
  /** Consultant-scoped accounts (CONSULTANT_PAYABLE, CONSULTANT_RECEIVABLE). */
  consultantProfileId?: string | null;
  /**
   * Leave unset (INR): the ledger is INR paise, and the sidecar CHECK
   * `ledger_account_currency_inr` rejects any other account currency.
   */
  currency?: Currency;
}

export interface Posting {
  account: AccountRef;
  direction: LedgerDirection;
  amountPaise: number;
}

export interface PostLedgerTxnInput {
  idempotencyKey: string;
  // #778 §B — typed txn kind (LedgerTransactionKind enum). Overage rides
  // existing kinds — CHARGE_ORG via INVOICE_*, CHARGE_MEMBER via its own
  // BOOKING-shaped side-charge posting (#775) — so there is no distinct OVERAGE.
  kind: LedgerTransactionKind;
  description?: string;
  paymentId?: string | null;
  invoiceId?: string | null;
  payoutId?: string | null;
  postings: Posting[];
}

export class LedgerImbalanceError extends Error {
  constructor(
    public idempotencyKey: string,
    public debitPaise: number,
    public creditPaise: number,
  ) {
    super(
      `Ledger transaction "${idempotencyKey}" unbalanced: debit=${debitPaise} credit=${creditPaise}`,
    );
    this.name = "LedgerImbalanceError";
  }
}

/** Deterministic account id for a scope; stable across calls, so inserts dedupe on the key. */
export function ledgerAccountId(ref: AccountRef): string {
  const currency = ref.currency ?? "INR";
  return `${ref.kind}|${ref.organizationId ?? "_"}|${ref.consultantProfileId ?? "_"}|${currency}`;
}

/**
 * Ensures every distinct account of one transaction exists in a single insert,
 * in id order so concurrent posters lock new rows in the same order. The
 * entries' foreign key is what proves each account exists.
 */
async function ensureAccounts(
  db: PrismaLike,
  refs: readonly AccountRef[],
): Promise<string[]> {
  const byId = new Map(refs.map((ref) => [ledgerAccountId(ref), ref]));
  await db.ledgerAccount.createMany({
    data: [...byId]
      .sort(([a], [b]) => Number(a > b) - Number(a < b))
      .map(([id, ref]) => ({
        id,
        kind: ref.kind,
        organizationId: ref.organizationId ?? null,
        consultantProfileId: ref.consultantProfileId ?? null,
        currency: ref.currency ?? "INR",
      })),
    skipDuplicates: true,
  });
  return refs.map(ledgerAccountId);
}

/** Keys whose replay already reported a mismatch in this process; bounded. */
const reportedReplayMismatches = new Set<string>();
const MAX_REPORTED_REPLAY_MISMATCHES = 500;

/**
 * A posted journal is immutable, so a replay that asks for a different debit
 * total or account set changes nothing; it is reported once per key per process.
 */
function reportReplayMismatch(
  input: PostLedgerTxnInput,
  requested: { debitPaise: number; accountIds: readonly string[] },
  stored: { debitPaise: number; accountIds: readonly string[] },
): void {
  if (reportedReplayMismatches.has(input.idempotencyKey)) return;
  if (reportedReplayMismatches.size >= MAX_REPORTED_REPLAY_MISMATCHES) {
    reportedReplayMismatches.clear();
  }
  reportedReplayMismatches.add(input.idempotencyKey);
  reportSentryMessage(
    `Ledger replay on "${input.idempotencyKey}" differs from the posted journal; nothing was changed`,
    {
      subsystem: "payments",
      op: "ledger.replay-mismatch",
      level: "error",
      extra: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        storedDebitPaise: stored.debitPaise,
        requestedDebitPaise: requested.debitPaise,
        storedAccountIds: stored.accountIds,
        requestedAccountIds: requested.accountIds,
      },
    },
  );
}

/**
 * Post a balanced double-entry transaction. Throws `LedgerImbalanceError` if
 * Σ(DEBIT) !== Σ(CREDIT). Idempotent on `idempotencyKey`: a replay returns
 * `created: false` and never throws, whatever it asked to post.
 */
export async function postLedgerTxn(
  db: PrismaLike,
  input: PostLedgerTxnInput,
): Promise<{ transactionId: string; created: boolean }> {
  if (input.postings.length === 0) {
    const err = new Error(
      `postLedgerTxn "${input.idempotencyKey}": no postings`,
    );
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  }
  let debit = 0;
  let credit = 0;
  for (const p of input.postings) {
    if (!Number.isInteger(p.amountPaise) || p.amountPaise <= 0) {
      const err = new Error(
        `postLedgerTxn "${input.idempotencyKey}": each posting must be a positive integer paise (got ${p.amountPaise})`,
      );
      reportSentryError(err, { subsystem: "payments" });
      throw err;
    }
    if (p.direction === "DEBIT") debit += p.amountPaise;
    else credit += p.amountPaise;
  }
  if (debit !== credit) {
    const err = new LedgerImbalanceError(input.idempotencyKey, debit, credit);
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  }

  // Idempotency fast-path. `idempotencyKey @unique` is the hard guard: if two
  // callers race, the loser's create throws P2002 (and inside a tx aborts it —
  // the retried tx then hits this fast-path).
  const existing = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true,
      entries: {
        select: { accountId: true, direction: true, amountPaise: true },
      },
    },
  });
  if (existing) {
    const storedAccountIds = distinctSorted(
      existing.entries.map((e) => e.accountId),
    );
    const requestedAccountIds = distinctSorted(
      input.postings.map((p) => ledgerAccountId(p.account)),
    );
    const storedDebitPaise = existing.entries
      .filter((e) => e.direction === "DEBIT")
      .reduce((sum, e) => sum + sumPaise(e.amountPaise), 0);
    if (
      storedDebitPaise !== debit ||
      storedAccountIds.join("\n") !== requestedAccountIds.join("\n")
    ) {
      reportReplayMismatch(
        input,
        { debitPaise: debit, accountIds: requestedAccountIds },
        { debitPaise: storedDebitPaise, accountIds: storedAccountIds },
      );
    } else {
      // A replayed caller hit an already-posted key: the system working as designed.
      reportSentryMessage("Ledger posting idempotency short-circuit", {
        subsystem: "payments",
        expected: true,
        extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
      });
    }
    return { transactionId: existing.id, created: false };
  }

  const accountIds = await ensureAccounts(
    db,
    input.postings.map((p) => p.account),
  );

  let txn: { id: string };
  try {
    txn = await db.ledgerTransaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        description: input.description,
        paymentId: input.paymentId ?? null,
        invoiceId: input.invoiceId ?? null,
        payoutId: input.payoutId ?? null,
        entries: {
          create: input.postings.map((p, i) => ({
            accountId: accountIds[i],
            direction: p.direction,
            amountPaise: BigInt(p.amountPaise),
          })),
        },
      },
      select: { id: true },
    });
  } catch (err) {
    // The findUnique above is a fast path, not a guard: between it and this
    // create, a concurrent poster with the same key can commit. The unique
    // index is the real protection, and it surfaces as P2002.
    //
    // Previously this always propagated, so correctness depended on EVERY call
    // site being wrapped in a retry — a contract no reviewer can enforce.
    //
    // What we can do depends on whether `db` is the base client or a
    // transaction client, and the caller knows but we do not:
    //
    //   - Base client: the failed INSERT is isolated, so re-reading gives us
    //     the winner's id and this call becomes a correct no-op.
    //   - Inside a transaction: Postgres has already aborted it (Prisma takes
    //     no savepoint), so the re-read below throws 25P02 too and the original
    //     P2002 propagates.
    //
    // Be honest about what that second case buys: today EVERY caller passes a
    // `tx`, and `withSerializableRetry` retries only P2034 — so nothing retries
    // a P2002 and this rescue is unreachable in the current call graph. It is
    // here so that the guarantee lives with the function rather than depending
    // on each future call site being wrapped correctly, and so a base-client
    // caller (there is no reason there won't be one) gets the right behaviour
    // for free. It is not a claim that today's callers recover.
    //
    // Trying the read and falling back covers both without having to ask.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      try {
        const winner = await db.ledgerTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (winner) {
          // Lost-race rescue succeeded — a concurrent poster with the same
          // key committed first. Modelled outcome, not a fault.
          reportSentryMessage("Ledger posting P2002 race rescued", {
            subsystem: "payments",
            expected: true,
            extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
          });
          return { transactionId: winner.id, created: false };
        }
      } catch (rescueErr) {
        // Aborted transaction — fall through and rethrow the original P2002.
        // This inner failure is itself expected inside a tx (Postgres already
        // aborted it, so ANY further read throws 25P02) — captured for
        // pattern visibility only, not as a new fault.
        reportSentryError(rescueErr, {
          subsystem: "payments",
          expected: true,
          extra: { idempotencyKey: input.idempotencyKey },
        });
      }
    }
    // An unrecovered ledger-write failure is reported here so every caller is
    // covered. A write conflict is retried by the caller, so it is not a fault.
    reportSentryError(err, {
      subsystem: "payments",
      expected: isWriteConflict(err),
      extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
    });
    throw err;
  }

  return { transactionId: txn.id, created: true };
}

/** Distinct values in code-unit order, so two sets compare by position. */
function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => Number(a > b) - Number(a < b));
}

/**
 * Signed balance (Σ DEBIT − Σ CREDIT) of an account, in paise, aggregated from
 * the journal. For liability accounts (WALLET, *_PAYABLE) the amount owed is the
 * negative of this (credit normal); callers interpret per kind.
 */
export async function ledgerBalancePaise(
  db: PrismaLike,
  ref: AccountRef,
): Promise<number> {
  const rows = await db.ledgerEntry.groupBy({
    by: ["direction"],
    where: { accountId: ledgerAccountId(ref) },
    _sum: { amountPaise: true },
  });
  // #780 — groupBy _sum bypasses the result extension; still bigint at runtime.
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    if (r.direction === "DEBIT") debit = sumPaise(r._sum.amountPaise);
    else credit = sumPaise(r._sum.amountPaise);
  }
  return debit - credit;
}
