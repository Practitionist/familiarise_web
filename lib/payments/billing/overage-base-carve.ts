import type { Tx } from "@/lib/prisma";
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

export type CarveOutcome = "restored" | "recarved" | "none" | "invoiced";

type CarveRef = { overageEventId: string } | { sidePaymentId: string };

type RestoreCarveTx = Pick<Tx, "overageEvent" | "payment" | "paymentLeg"> &
  Partial<
    Pick<
      Tx,
      | "dispute"
      | "consultantEarnings"
      | "organizationEarnings"
      | "billingAccount"
      | "ledgerTransaction"
      | "ledgerAccount"
      | "ledgerAccountBalance"
    >
  >;

export async function releaseOverageHeldParentEarnings(
  tx: Partial<
    Pick<Tx, "dispute" | "consultantEarnings" | "organizationEarnings">
  >,
  parentPaymentId: string,
): Promise<void> {
  const openDisputes =
    typeof tx.dispute?.count === "function"
      ? await tx.dispute.count({
          where: {
            paymentId: parentPaymentId,
            status: { notIn: ["WON", "LOST"] },
          },
        })
      : 0;
  if (openDisputes > 0) return;

  if (typeof tx.consultantEarnings?.updateMany === "function") {
    await tx.consultantEarnings.updateMany({
      where: {
        paymentId: parentPaymentId,
        status: "HELD",
        preDisputeStatus: "PENDING",
      },
      data: { status: "PENDING", preDisputeStatus: null },
    });
  }
  if (typeof tx.organizationEarnings?.updateMany === "function") {
    await tx.organizationEarnings.updateMany({
      where: {
        paymentId: parentPaymentId,
        status: "HELD",
        preDisputeStatus: "PENDING",
      },
      data: { status: "PENDING", preDisputeStatus: null },
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
  return { event, parent };
}

/**
 * FAILED edge: return the carved basePaise to the parent's INVOICE_ACCRUAL
 * or WALLET leg + amount and release any overage-held earnings on the parent
 * payment. For LICENSE parents (whose booking leg is ₹0 and cannot absorb the
 * uncollected over-cap base), leave parent earnings held so uncollected base
 * is never disbursed. Call ONLY after a successful PENDING→FAILED CAS, in the
 * same tx.
 */
export async function restoreOverageBaseCarve(
  tx: RestoreCarveTx,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx) return "none";

  if (ctx.event.basePaise <= 0) {
    await releaseOverageHeldParentEarnings(tx, ctx.parent.id);
    return "none";
  }

  if (typeof tx.paymentLeg?.findUnique === "function") {
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
      if (
        ctx.parent.billingAccountId &&
        typeof tx.billingAccount?.updateMany === "function"
      ) {
        const { walletDebit } = await import("@/lib/api/organizations/wallet");
        await walletDebit(tx as unknown as Tx, {
          billingAccountId: ctx.parent.billingAccountId,
          amountPaise: ctx.event.basePaise,
          reason: "BOOKING",
          paymentId: ctx.parent.id,
        });
      }
      await tx.payment.updateMany({
        where: { id: ctx.parent.id },
        data: { amount: { increment: ctx.event.basePaise } },
      });
      await tx.paymentLeg.update({
        where: {
          paymentId_source: { paymentId: ctx.parent.id, source: "WALLET" },
        },
        data: { amountPaise: { increment: ctx.event.basePaise } },
      });
      await releaseOverageHeldParentEarnings(tx, ctx.parent.id);
      return "restored";
    }
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
  await releaseOverageHeldParentEarnings(tx, ctx.parent.id);
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
      Math.round((oldSubtotal * standardGstRateBps) / 10_000) === oldTax;
    newTax = matchesStandardGst
      ? Math.round((newSubtotal * standardGstRateBps) / 10_000)
      : Math.round((oldTax * newSubtotal) / Math.max(1, oldSubtotal));
  }
  const interState = oldIgst > 0;
  const newIgst = interState ? newTax : 0;
  const newSgst = interState ? 0 : Math.floor(newTax / 2);
  const newCgst = interState ? 0 : newTax - newSgst;
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
 * Recovery edges (FAILED→PENDING retry, FAILED→CHARGED late capture): carve
 * basePaise back out. Call ONLY after a successful CAS from FAILED, in the
 * same tx. "invoiced" = the parent rolled onto an invoice while FAILED
 * (restored base was billed) — the caller must refuse the retry / flag the
 * capture, because the member paying now would double-collect basePaise.
 */
export async function recarveOverageBase(
  tx: RecarveTx,
  ref: CarveRef,
): Promise<CarveOutcome> {
  const ctx = await loadCarveContext(tx, ref);
  if (!ctx || ctx.event.basePaise <= 0) return "none";

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
