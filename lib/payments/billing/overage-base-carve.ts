import { EarningStatus, EarningsHoldReason, type Prisma } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import type { Posting } from "@/lib/payments/ledger/post";
import { prorate, sumPaise } from "@/lib/payments/utils/money";
import {
  placeEarningsHolds,
  releaseEarningsHolds,
  type EarningsHoldDb,
} from "@/lib/payments/payouts/earnings-holds";
/**
 * #812 §P0 / #775 / #782 — basePaise carve bookkeeping for CHARGE_MEMBER
 * overage side-charges.
 *
 * At booking time, overage-settlement carves the over-cap pass-through
 * (basePaise) OUT of the parent payment's INVOICE_ACCRUAL leg — the org pays
 * only the covered portion; the member's side-charge collects base +
 * surcharge. Until #812 the three abandon paths (gateway failure, abandoned
 * sweep, 14-day timeout) FAILed the side-charge without putting basePaise
 * back, silently under-billing the org for a session its member consumed.
 *
 * restore = FAILED: give the parent accrual its basePaise back so the next
 * invoice rollup bills the org correctly. recarve = the recovery edges
 * (FAILED→PENDING retry, FAILED→CHARGED late capture): take it out again so
 * the member's payment doesn't double-collect with the org's invoice.
 *
 * Both are gated by the caller's CAS transition (run ONLY when the claim
 * matched a row), which makes them exactly-once per edge. If the parent was
 * already rolled onto an invoice (billableToOrgInvoiceId set), touching the
 * leg would silently diverge from the issued document — those cases return
 * "invoiced" and the caller surfaces a SystemEvent / 409 instead.
 *
 * Dependency-light (Prisma types only) so the sweep jobs can import it.
 */

/** "receivable": a wallet parent's base the wallet could not fully cover, booked as ORG_RECEIVABLE. */
export type CarveOutcome =
  "restored" | "recarved" | "none" | "invoiced" | "receivable";

type CarveRef = { overageEventId: string } | { sidePaymentId: string };

/**
 * Release the parent's OVERAGE holds once no other member overage on it is
 * unpaid. A FAILED one still holds on a LICENSE parent, whose base was never
 * restored to the org, until it is charged, settled to the org or reversed.
 * Other owners' holds on the same earnings stay.
 */
export async function releaseOverageHeldParentEarnings(
  tx: Pick<Tx, "overageEvent" | "paymentLeg"> & EarningsHoldDb,
  parentPaymentId: string,
  settledSidePaymentId?: string,
): Promise<void> {
  const overageHeld = {
    paymentId: parentPaymentId,
    holds: {
      some: {
        reason: EarningsHoldReason.OVERAGE,
        sourceRef: parentPaymentId,
        releasedAt: null,
      },
    },
  };
  const consultantIds = (
    await tx.consultantEarnings.findMany({
      where: overageHeld,
      select: { id: true },
    })
  ).map((r) => r.id);
  const orgIds = (
    await tx.organizationEarnings.findMany({
      where: overageHeld,
      select: { id: true },
    })
  ).map((r) => r.id);
  if (consultantIds.length + orgIds.length === 0) return;
  // Lock the held rows before counting: a batch holding them concurrently is
  // then either committed and counted, or forces this transaction to retry.
  await lockHeldOverageEarnings(tx, consultantIds, orgIds);
  const unpaidSiblings = await tx.overageEvent.count({
    where: await unpaidMemberOverageWhere(
      tx,
      parentPaymentId,
      settledSidePaymentId,
    ),
  });
  if (unpaidSiblings > 0) return;

  const match = {
    reasons: [EarningsHoldReason.OVERAGE],
    sourceRef: parentPaymentId,
  };
  await releaseEarningsHolds(tx, "consultant", consultantIds, match);
  await releaseEarningsHolds(tx, "org", orgIds, match);
}

/** The parent's member overages still owed: PENDING, or FAILED on a LICENSE parent. */
async function unpaidMemberOverageWhere(
  tx: Pick<Tx, "paymentLeg">,
  parentPaymentId: string,
  settledSidePaymentId?: string,
): Promise<Prisma.OverageEventWhereInput> {
  const licenseLeg = await tx.paymentLeg.findUnique({
    where: {
      paymentId_source: { paymentId: parentPaymentId, source: "LICENSE" },
    },
    select: { amountPaise: true },
  });
  return {
    overageBehavior: "CHARGE_MEMBER",
    chargeStatus: { in: licenseLeg ? ["PENDING", "FAILED"] : ["PENDING"] },
    ...(settledSidePaymentId && { paymentId: { not: settledSidePaymentId } }),
    payment: { parentPaymentId },
  };
}

/** Unreleased statuses the overage hold freezes; a trust-parked row keeps its park under the hold. */
const OVERAGE_HOLDABLE = [EarningStatus.PENDING, EarningStatus.PENDING_TRUST];

/**
 * Places the parent's OVERAGE hold on its unreleased earnings; rows an earlier
 * batch already holds are written again, so a concurrent release waits for this one.
 */
export async function holdParentEarningsForMemberOverage(
  tx: EarningsHoldDb,
  parentPaymentId: string,
): Promise<void> {
  const holdable = {
    paymentId: parentPaymentId,
    OR: [
      { status: { in: OVERAGE_HOLDABLE } },
      { status: EarningStatus.HELD, preHoldStatus: { in: OVERAGE_HOLDABLE } },
    ],
  };
  const consultantIds = (
    await tx.consultantEarnings.findMany({
      where: holdable,
      select: { id: true },
    })
  ).map((r) => r.id);
  const orgIds = (
    await tx.organizationEarnings.findMany({
      where: holdable,
      select: { id: true },
    })
  ).map((r) => r.id);
  await lockHeldOverageEarnings(tx, consultantIds, orgIds);
  const overageHold = {
    reason: EarningsHoldReason.OVERAGE,
    sourceRef: parentPaymentId,
  };
  await placeEarningsHolds(tx, "consultant", consultantIds, overageHold);
  await placeEarningsHolds(tx, "org", orgIds, overageHold);
}

/** Earnings written while a member overage on their payment is still owed start under its hold. */
export async function holdNewEarningsForUnpaidMemberOverage(
  tx: Pick<Tx, "overageEvent" | "paymentLeg"> & EarningsHoldDb,
  paymentId: string,
): Promise<void> {
  // A no-op write on the owed overages: every path that settles one moves its
  // row first, so it either commits before this read or waits for this hold.
  const owed = await tx.overageEvent.updateMany({
    where: await unpaidMemberOverageWhere(tx, paymentId),
    data: { chargeAttemptCount: { increment: 0 } },
  });
  if (owed.count === 0) return;
  await holdParentEarningsForMemberOverage(tx, paymentId);
}

/** A no-op write on the parent's HELD earnings, taken by both the overage place and release. */
export async function lockHeldOverageEarnings(
  tx: EarningsHoldDb,
  consultantIds: string[],
  orgIds: string[],
): Promise<void> {
  const held = { status: EarningStatus.HELD };
  if (consultantIds.length > 0) {
    await tx.consultantEarnings.updateMany({
      where: { id: { in: consultantIds }, ...held },
      data: held,
    });
  }
  if (orgIds.length > 0) {
    await tx.organizationEarnings.updateMany({
      where: { id: { in: orgIds }, ...held },
      data: held,
    });
  }
}

async function loadCarveContext(
  tx: Pick<Tx, "overageEvent" | "payment">,
  ref: CarveRef,
) {
  const event = await tx.overageEvent.findFirst({
    where:
      "overageEventId" in ref
        ? { id: ref.overageEventId }
        : { paymentId: ref.sidePaymentId },
    select: {
      id: true,
      basePaise: true,
      overageBehavior: true,
      payment: { select: { id: true, parentPaymentId: true } },
    },
  });
  if (
    !event ||
    event.overageBehavior !== "CHARGE_MEMBER" ||
    !event.payment?.parentPaymentId
  ) {
    return null;
  }
  const parent = await tx.payment.findUnique({
    where: { id: event.payment.parentPaymentId },
    select: {
      id: true,
      billableToOrgInvoiceId: true,
      billingAccountId: true,
    },
  });
  if (!parent) return null;
  return { event, parent, sidePaymentId: event.payment.id };
}

/**
 * The restore journal for a wallet-funded parent. The parent's booking journal
 * funded the carved base from its DISCOUNT plug, so the restore moves it off
 * DISCOUNT: Dr WALLET for what the wallet covered, Dr ORG_RECEIVABLE for the
 * rest, once per overage event. A parent whose booking journal has not posted
 * yet tallies the WALLET leg itself, so only the receivable posts here.
 */
async function journalWalletBaseRestore(
  tx: Tx,
  args: {
    parentPaymentId: string;
    ownerOrgId: string;
    overageEventId: string;
    walletPaise: number;
    receivablePaise: number;
  },
): Promise<void> {
  const booking = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: `booking:${args.parentPaymentId}` },
    select: { id: true },
  });
  const walletPaise = booking ? args.walletPaise : 0;
  if (walletPaise + args.receivablePaise === 0) return;
  const { postLedgerTxn } = await import("@/lib/payments/ledger/post");
  const debits: Posting[] = [
    {
      account: { kind: "WALLET", organizationId: args.ownerOrgId },
      direction: "DEBIT",
      amountPaise: walletPaise,
    },
    {
      account: { kind: "ORG_RECEIVABLE", organizationId: args.ownerOrgId },
      direction: "DEBIT",
      amountPaise: args.receivablePaise,
    },
  ];
  const posted = await postLedgerTxn(tx, {
    idempotencyKey: `overage-restore:${args.overageEventId}`,
    kind: "OVERAGE_MEMBER",
    paymentId: args.parentPaymentId,
    description:
      args.receivablePaise > 0
        ? `Abandoned member overage ${args.overageEventId}: base restored, ${args.receivablePaise} paise the org wallet could not cover booked as receivable`
        : `Abandoned member overage ${args.overageEventId}: base restored onto the org wallet`,
    postings: [
      ...debits.filter((d) => d.amountPaise > 0),
      {
        account: { kind: "DISCOUNT" },
        direction: "CREDIT",
        amountPaise: walletPaise + args.receivablePaise,
      },
    ],
  });
  // The wallet was just debited again; without a fresh journal line that is drift.
  if (!posted.created) {
    throw new Error(
      `restoreOverageBaseCarve: overage ${args.overageEventId} was already restored onto the wallet; refusing an unjournaled second debit`,
    );
  }
}

/** Debits up to `amountPaise` from the wallet, never below zero; returns what it took. */
async function debitWalletUpTo(
  tx: Tx,
  billingAccountId: string,
  amountPaise: number,
  paymentId: string,
): Promise<{ ownerOrgId: string; debitedPaise: number }> {
  const { walletDebit, WalletInsufficientFundsError } =
    await import("@/lib/api/organizations/wallet");
  const tryDebit = async (paise: number) => {
    try {
      const { ownerOrgId } = await walletDebit(tx, {
        billingAccountId,
        amountPaise: paise,
        reason: "BOOKING",
        paymentId,
      });
      return ownerOrgId;
    } catch (err) {
      if (err instanceof WalletInsufficientFundsError) return null;
      throw err;
    }
  };
  const fullOwner = await tryDebit(amountPaise);
  if (fullOwner) return { ownerOrgId: fullOwner, debitedPaise: amountPaise };

  const acct = await tx.billingAccount.findUniqueOrThrow({
    where: { id: billingAccountId },
    select: { walletBalance: true, ownerOrgId: true },
  });
  const available = Math.min(
    Math.max(Number(acct.walletBalance ?? 0), 0),
    amountPaise,
  );
  const debited = available > 0 && (await tryDebit(available)) ? available : 0;
  return { ownerOrgId: acct.ownerOrgId, debitedPaise: debited };
}

/**
 * FAILED edge: return the carved basePaise to the parent's INVOICE_ACCRUAL
 * or WALLET leg + amount and release any overage-held earnings on the parent
 * payment. For LICENSE parents (whose booking leg is ₹0 and cannot absorb the
 * uncollected over-cap base), leave parent earnings held so uncollected base
 * is never disbursed. A wallet short of the base gives what it holds and the
 * rest books as ORG_RECEIVABLE ("receivable"). Call ONLY after a successful
 * PENDING→FAILED CAS, in the same tx.
 */
export async function restoreOverageBaseCarve(
  tx: Tx,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx) return "none";

  if (ctx.event.basePaise <= 0) {
    await releaseOverageHeldParentEarnings(
      tx,
      ctx.parent.id,
      ctx.sidePaymentId,
    );
    return "none";
  }

  const licenseLeg = await tx.paymentLeg.findUnique({
    where: {
      paymentId_source: { paymentId: ctx.parent.id, source: "LICENSE" },
    },
    select: { amountPaise: true },
  });
  if (licenseLeg) {
    // LICENSE booking legs carry ₹0 (prepaid at contract level), so an
    // abandoned member side-charge has no parent accrual or wallet leg to
    // restore basePaise onto; keep parent earnings held until resolved.
    return "none";
  }

  const walletLeg = await tx.paymentLeg.findUnique({
    where: {
      paymentId_source: { paymentId: ctx.parent.id, source: "WALLET" },
    },
    select: { amountPaise: true },
  });
  if (walletLeg) {
    let walletPaise = ctx.event.basePaise;
    if (ctx.parent.billingAccountId) {
      const { ownerOrgId, debitedPaise } = await debitWalletUpTo(
        tx,
        ctx.parent.billingAccountId,
        ctx.event.basePaise,
        ctx.parent.id,
      );
      walletPaise = debitedPaise;
      await journalWalletBaseRestore(tx, {
        parentPaymentId: ctx.parent.id,
        ownerOrgId,
        overageEventId: ctx.event.id,
        walletPaise,
        receivablePaise: ctx.event.basePaise - walletPaise,
      });
    }
    // Only the wallet-covered part joins the WALLET leg; the rest lives on ORG_RECEIVABLE.
    if (walletPaise > 0) {
      await tx.payment.updateMany({
        where: { id: ctx.parent.id },
        data: { amount: { increment: walletPaise } },
      });
      await tx.paymentLeg.update({
        where: {
          paymentId_source: { paymentId: ctx.parent.id, source: "WALLET" },
        },
        data: { amountPaise: { increment: walletPaise } },
      });
    }
    await releaseOverageHeldParentEarnings(
      tx,
      ctx.parent.id,
      ctx.sidePaymentId,
    );
    return walletPaise < ctx.event.basePaise ? "receivable" : "restored";
  }

  // Guarded parent-first write: the invoiced check rides the UPDATE's WHERE
  // (re-evaluated under the row lock), so a rollup stamping
  // billableToOrgInvoiceId between our read and this write yields count 0
  // instead of silently diverging the leg from the issued document.
  const parentBumped = await tx.payment.updateMany({
    where: { id: ctx.parent.id, billableToOrgInvoiceId: null },
    data: { amount: { increment: ctx.event.basePaise } },
  });
  if (parentBumped.count === 0) return "invoiced";

  await tx.paymentLeg.update({
    where: {
      paymentId_source: { paymentId: ctx.parent.id, source: "INVOICE_ACCRUAL" },
    },
    data: { amountPaise: { increment: ctx.event.basePaise } },
  });
  await releaseOverageHeldParentEarnings(tx, ctx.parent.id, ctx.sidePaymentId);
  return "restored";
}

type RecarveTx = Pick<Tx, "overageEvent" | "payment" | "paymentLeg"> &
  Partial<Pick<Tx, "organizationInvoice" | "invoiceLineItem">>;

function computeRecarvedDraftInvoiceTotals(
  invoice: {
    subtotalPaise: number | bigint;
    igstPaise?: number | bigint | null;
    cgstPaise?: number | bigint | null;
    sgstPaise?: number | bigint | null;
  },
  basePaise: number,
) {
  const oldSubtotal = Math.max(0, Number(invoice.subtotalPaise));
  const newSubtotal = Math.max(0, oldSubtotal - basePaise);
  const oldIgst = Number(invoice.igstPaise ?? 0);
  const oldCgst = Number(invoice.cgstPaise ?? 0);
  const oldSgst = Number(invoice.sgstPaise ?? 0);
  const oldTax = oldIgst + oldCgst + oldSgst;
  const standardGstRateBps = 1800;
  let newTax = 0;
  if (oldTax > 0 && newSubtotal > 0) {
    const matchesStandardGst =
      prorate(oldSubtotal, standardGstRateBps, 10_000, "round") === oldTax;
    newTax = matchesStandardGst
      ? prorate(newSubtotal, standardGstRateBps, 10_000, "round")
      : prorate(oldTax, newSubtotal, Math.max(1, oldSubtotal), "round");
  }
  const interState = oldIgst > 0;
  const newIgst = interState ? newTax : 0;
  const newCgst = interState ? 0 : Math.floor(newTax / 2);
  const newSgst = interState ? 0 : newTax - newCgst;
  const newTotal = newSubtotal + newTax;

  return {
    subtotalPaise: newSubtotal,
    igstPaise: newIgst,
    cgstPaise: newCgst,
    sgstPaise: newSgst,
    totalPaise: newTotal,
    inrEquivalentPaise: newTotal,
  };
}

async function persistRecarvedDraftInvoice(
  tx: RecarveTx,
  invoiceId: string,
  updatedInvoiceData: ReturnType<typeof computeRecarvedDraftInvoiceTotals>,
): Promise<void> {
  if (typeof tx.organizationInvoice?.updateMany === "function") {
    const invoiceUpdated = await tx.organizationInvoice.updateMany({
      where: { id: invoiceId, status: "DRAFT" },
      data: updatedInvoiceData,
    });
    if (invoiceUpdated.count === 0) {
      throw new Error(
        `recarveOverageBase: invoice ${invoiceId} transitioned out of DRAFT during recarve — rolling back`,
      );
    }
    if (typeof tx.organizationInvoice.update === "function") {
      await tx.organizationInvoice.update({
        where: { id: invoiceId },
        data: updatedInvoiceData,
      });
    }
    return;
  }
  if (typeof tx.organizationInvoice?.update === "function") {
    await tx.organizationInvoice.update({
      where: { id: invoiceId },
      data: updatedInvoiceData,
    });
  }
}

async function recarveDraftInvoiceBase(
  tx: RecarveTx,
  parentId: string,
  basePaise: number,
  invoiceId: string | null,
): Promise<CarveOutcome> {
  if (
    !invoiceId ||
    typeof tx.organizationInvoice?.findUnique !== "function" ||
    (typeof tx.organizationInvoice?.updateMany !== "function" &&
      typeof tx.organizationInvoice?.update !== "function")
  ) {
    return "invoiced";
  }

  const invoice = await tx.organizationInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      subtotalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
      totalPaise: true,
    },
  });
  if (invoice?.status !== "DRAFT") {
    return "invoiced";
  }

  const draftParentCut = await tx.payment.updateMany({
    where: { id: parentId, billableToOrgInvoiceId: invoice.id },
    data: { amount: { decrement: basePaise } },
  });
  if (draftParentCut.count === 0) return "invoiced";

  const draftCarved = await tx.paymentLeg.updateMany({
    where: {
      paymentId: parentId,
      source: "INVOICE_ACCRUAL",
      amountPaise: { gte: basePaise },
    },
    data: { amountPaise: { decrement: basePaise } },
  });
  if (draftCarved.count === 0) {
    throw new Error(
      `recarveOverageBase: INVOICE_ACCRUAL leg on payment ${parentId} is missing the restored basePaise=${basePaise} — rolling back`,
    );
  }

  if (typeof tx.invoiceLineItem?.updateMany === "function") {
    await tx.invoiceLineItem.updateMany({
      where: { invoiceId: invoice.id, paymentId: parentId },
      data: { unitPricePaise: { decrement: basePaise } },
    });
  }

  const updatedInvoiceData = computeRecarvedDraftInvoiceTotals(
    invoice,
    basePaise,
  );
  await persistRecarvedDraftInvoice(tx, invoice.id, updatedInvoiceData);
  return "recarved";
}

/**
 * Undoes a wallet restore: the base the restore put on the WALLET leg goes back
 * to the wallet, and its ORG_RECEIVABLE part is cancelled, or refunded to the
 * wallet where a top-up already settled it. Mirrors `journalWalletCarveCredit`.
 */
async function recarveWalletBase(
  tx: Tx,
  ctx: NonNullable<Awaited<ReturnType<typeof loadCarveContext>>>,
): Promise<CarveOutcome> {
  const { event, parent } = ctx;
  const restoreReceivable = await tx.ledgerEntry.findFirst({
    where: {
      direction: "DEBIT",
      account: { kind: "ORG_RECEIVABLE" },
      transaction: { idempotencyKey: `overage-restore:${event.id}` },
    },
    select: { amountPaise: true },
  });
  const receivablePaise = sumPaise(restoreReceivable?.amountPaise);
  const legPaise = event.basePaise - receivablePaise;

  if (legPaise > 0) {
    const carved = await tx.paymentLeg.updateMany({
      where: {
        paymentId: parent.id,
        source: "WALLET",
        amountPaise: { gte: legPaise },
      },
      data: { amountPaise: { decrement: legPaise } },
    });
    if (carved.count === 0) {
      throw new Error(
        `recarveOverageBase: WALLET leg on payment ${parent.id} is missing the restored ${legPaise} paise — rolling back`,
      );
    }
    await tx.payment.updateMany({
      where: { id: parent.id },
      data: { amount: { decrement: legPaise } },
    });
  }
  if (!parent.billingAccountId) return "recarved";

  const { openShortfallReceivablePaise, walletCredit } =
    await import("@/lib/api/organizations/wallet");
  // A no-op write row-locks the account, as confirmTopUp does, so a racing top-up settles first or after.
  const { ownerOrgId } = await tx.billingAccount.update({
    where: { id: parent.billingAccountId },
    data: { walletBalance: { increment: 0 } },
    select: { ownerOrgId: true },
  });
  const receivableBackPaise = Math.min(
    receivablePaise,
    await openShortfallReceivablePaise(tx, ownerOrgId),
  );
  const settledBackPaise = receivablePaise - receivableBackPaise;
  if (legPaise + settledBackPaise > 0) {
    await walletCredit(tx, {
      billingAccountId: parent.billingAccountId,
      amountPaise: legPaise + settledBackPaise,
      reason: "REFUND",
      paymentId: parent.id,
    });
  }

  // Until the parent's booking journal posts, it tallies the WALLET leg itself.
  const booking = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: `booking:${parent.id}` },
    select: { id: true },
  });
  const walletPaise = (booking ? legPaise : 0) + settledBackPaise;
  if (walletPaise + receivableBackPaise === 0) return "recarved";
  const { postLedgerTxn } = await import("@/lib/payments/ledger/post");
  const credits: Posting[] = [
    {
      account: { kind: "WALLET", organizationId: ownerOrgId },
      direction: "CREDIT",
      amountPaise: walletPaise,
    },
    {
      account: { kind: "ORG_RECEIVABLE", organizationId: ownerOrgId },
      direction: "CREDIT",
      amountPaise: receivableBackPaise,
    },
  ];
  const posted = await postLedgerTxn(tx, {
    idempotencyKey: `overage-recarve:${event.id}`,
    kind: "OVERAGE_MEMBER",
    paymentId: parent.id,
    description: `Member overage ${event.id} paid late: restored base carved back onto the org wallet`,
    postings: [
      {
        account: { kind: "DISCOUNT" },
        direction: "DEBIT",
        amountPaise: walletPaise + receivableBackPaise,
      },
      ...credits.filter((c) => c.amountPaise > 0),
    ],
  });
  // The wallet was just credited again; without a fresh journal line that is drift.
  if (!posted.created) {
    throw new Error(
      `recarveOverageBase: overage ${event.id} was already recarved onto the wallet; refusing an unjournaled second credit`,
    );
  }
  return "recarved";
}

/**
 * Recovery edges (FAILED→PENDING retry, FAILED→CHARGED late capture): carve
 * basePaise back out of the leg the restore put it on. Call ONLY after a
 * successful CAS from FAILED, in the same tx. "invoiced" = the parent rolled
 * onto an invoice while FAILED (restored base was billed) — the caller must
 * refuse the retry / flag the capture, because the member paying now would
 * double-collect basePaise.
 */
export async function recarveOverageBase(
  tx: Tx,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx || ctx.event.basePaise <= 0) return "none";

  // The restore leaves a LICENSE parent untouched, so there is nothing to take back.
  const parentLeg = (source: "LICENSE" | "WALLET") =>
    tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId: ctx.parent.id, source } },
      select: { amountPaise: true },
    });
  if (await parentLeg("LICENSE")) return "none";
  if (await parentLeg("WALLET")) return recarveWalletBase(tx, ctx);

  // Guarded parent-first write — same TOCTOU shape as the restore above.
  const parentCut = await tx.payment.updateMany({
    where: { id: ctx.parent.id, billableToOrgInvoiceId: null },
    data: { amount: { decrement: ctx.event.basePaise } },
  });
  if (parentCut.count === 0) {
    // #1900: Check if the parent payment's linked invoice is still in DRAFT
    // status. If DRAFT, adjust the DRAFT invoice, its line item, the parent
    // payment, and the INVOICE_ACCRUAL leg in-place; only ISSUED/PAID/OVERDUE
    // invoices take the post-invoice credit-note path ("invoiced").
    return recarveDraftInvoiceBase(
      tx,
      ctx.parent.id,
      ctx.event.basePaise,
      ctx.parent.billableToOrgInvoiceId,
    );
  }

  // Guarded decrement — mirrors the original carve's fail-closed stance.
  // Count 0 here means the leg lacks the restored base while the parent is
  // still uninvoiced: an invariant breach, not a billing race. Throw so the
  // caller's tx rolls the parent decrement back instead of half-applying.
  const carved = await tx.paymentLeg.updateMany({
    where: {
      paymentId: ctx.parent.id,
      source: "INVOICE_ACCRUAL",
      amountPaise: { gte: ctx.event.basePaise },
    },
    data: { amountPaise: { decrement: ctx.event.basePaise } },
  });
  if (carved.count === 0) {
    throw new Error(
      `recarveOverageBase: INVOICE_ACCRUAL leg on payment ${ctx.parent.id} is missing the restored basePaise=${ctx.event.basePaise} — rolling back`,
    );
  }
  return "recarved";
}
