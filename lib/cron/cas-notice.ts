import {
  attemptTrigger,
  type StagedTrigger,
  type TriggerResult,
} from "@/lib/novu/outbox";

/** The CAS verdict: how many rows the guarded write matched. */
export interface CasClaimVerdict {
  count: number;
}

/**
 * #1859 M-P0-11 — the one CAS-plus-notice gate for money-row sweepers.
 *
 * A cron double-fire (ticker + Actions re-run + dispatch re-run) can run the
 * same money row twice. The lock collapses most of that to a single run, but
 * the lock is mutual exclusion only — data correctness comes from the CAS
 * write, never from Redis (ADR 13). So every healer claims its row with
 * `updateMany({ where: { id, <status>: { in: fromIn } } })` and sends the
 * notice (email / outbox bell / Sentry page) only when that claim wins
 * (`count === 1`). The loser sees `count === 0` and stages nothing.
 *
 * Canonical claim shape per row-class (the caller supplies `claim`; this
 * helper only enforces the win check and the post-commit relay):
 * - Payment: `tx.payment.updateMany({ where: { id, paymentStatus: { in: fromIn } }, data })`
 * - Refund: `tx.refund.updateMany({ where: { id, status: { in: fromIn } }, data })`
 * - Payout: `tx.payout.updateMany({ where: { id, status: { in: fromIn } }, data })`
 * - Appointment: `transition*Request(tx, { where: { id, ... }, to, fromIn })`
 *   (throws `IllegalTransitionError` on loss — translate that to
 *   `{ count: 0 }` at the call site).
 *
 * Outbox relay: `notify` runs after the commit. When it staged its rows
 * inside the claim transaction (`{ tx }`) or with `{ deferAttempt }`, each
 * result carries `staged` with no `outcome` — the row exists but was never
 * attempted. The win owner attempts those rows here, post-commit, so a
 * freeze between commit and attempt still leaves the drain a row to finish
 * (`672b256a4` stage-outbox-before-response). Results a notify fn already
 * attempted inline carry `outcome` and are left alone (re-attempting would
 * re-send on the wire; Novu would dedupe on `transactionId`, but the extra
 * call is still wasted).
 *
 * @returns true when this caller won the claim (and notified), false when
 *   another writer moved the row first (nothing staged, nothing sent).
 */
export async function claimAndNotifyOnce(args: {
  claim: () => Promise<CasClaimVerdict>;
  notify: () => Promise<TriggerResult | TriggerResult[] | void>;
}): Promise<boolean> {
  const verdict = await args.claim();
  if (verdict.count !== 1) return false;

  const result = await args.notify();
  const results =
    result === undefined ? [] : Array.isArray(result) ? result : [result];
  const staged = results
    .filter((r) => r.staged && !r.outcome)
    .map((r) => r.staged as StagedTrigger);
  await Promise.all(
    staged.map((row) =>
      attemptTrigger(row).catch((err: unknown) => {
        console.error(`[cas-notice] post-commit attempt failed:`, err);
      }),
    ),
  );
  return true;
}
