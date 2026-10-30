import prisma, { type Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import {
  MONEY_EMAIL_TYPES,
  prepareDigitalProductPurchaseEmail,
  stageDigitalProductPurchaseEmail,
  type PreparedDigitalProductPurchaseEmail,
  type ReceiptStagingTx,
} from "@/lib/email/senders/money";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";

/**
 * The buyer's purchase receipt: rendered before the settling or claiming
 * transaction, staged inside it with `receiptStagedAt`, and attempted after
 * commit. A receipt that could not be prepared stays owed (null stamp) for the
 * recovery sweep; a staged row the attempt never reached goes to the email retry sweep.
 */

export type DigitalProductReceipt = PreparedDigitalProductPurchaseEmail;

interface ReceiptInput {
  purchaseId: string;
  buyerId: string;
  productId: string;
  amountPaise: number;
}

/** Render the receipt for a purchase about to be settled or claimed; null when it cannot be built. */
export async function prepareDigitalProductReceipt(
  input: ReceiptInput,
): Promise<DigitalProductReceipt | null> {
  try {
    return await buildReceipt(input);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      op: "digital-product.purchase-email",
      level: "warning",
      extra: { purchaseId: input.purchaseId },
    });
    return null;
  }
}

async function buildReceipt(
  input: ReceiptInput,
): Promise<DigitalProductReceipt | null> {
  const [product, buyer] = await Promise.all([
    prisma.digitalProduct.findUnique({
      where: { id: input.productId },
      select: {
        slug: true,
        title: true,
        consultantProfile: { select: { user: { select: { name: true } } } },
      },
    }),
    prisma.user.findUnique({
      where: { id: input.buyerId },
      select: { consulteeProfileId: true },
    }),
  ]);
  if (!product) return null;
  return await prepareDigitalProductPurchaseEmail({
    purchaseId: input.purchaseId,
    buyerId: input.buyerId,
    productTitle: product.title,
    creatorName: product.consultantProfile.user.name,
    amountPaise: input.amountPaise,
    libraryHref: buyer?.consulteeProfileId
      ? goHref("client", "products")
      : `/explore/products/${product.slug}`,
  });
}

/**
 * Stage the receipt inside the transaction that settles or claims the purchase
 * and stamp it handled; a preference skip is handled too, a failed preparation stays owed.
 */
export async function stageDigitalProductReceipt(
  tx: ReceiptStagingTx & Pick<Tx, "digitalProductPurchase">,
  receipt: DigitalProductReceipt | null,
): Promise<StagedRecipientEmail[]> {
  if (!receipt || receipt.prepared.failed > 0) return [];
  const staged = await stageDigitalProductPurchaseEmail(tx, receipt);
  await tx.digitalProductPurchase.updateMany({
    where: { id: receipt.purchaseId, receiptStagedAt: null },
    data: { receiptStagedAt: new Date() },
  });
  return staged;
}

/** Leaves the settling or claiming request its own attempt first. */
const OWED_RECEIPT_GRACE_MS = 5 * 60_000;
/** Older owed receipts are reported, not sent; the claim TTL outlives this window. */
const OWED_RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface OwedReceiptsResult {
  checked: number;
  /** Purchases whose receipt obligation was discharged this run. */
  handled: number;
  failedIds: string[];
  firstError?: unknown;
}

/**
 * Prepare and stage receipts still owed on SUCCEEDED purchases, least recently
 * checked first; the purchase claim keeps a re-run from staging twice.
 */
export async function stageOwedDigitalProductReceipts(
  limit: number,
  now: Date,
): Promise<OwedReceiptsResult> {
  const rows = await prisma.digitalProductPurchase.findMany({
    where: {
      status: "SUCCEEDED",
      receiptStagedAt: null,
      createdAt: {
        lt: new Date(now.getTime() - OWED_RECEIPT_GRACE_MS),
        gt: new Date(now.getTime() - OWED_RECEIPT_WINDOW_MS),
      },
    },
    orderBy: [
      { reconciledAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    take: limit,
    select: { id: true, buyerId: true, productId: true, amountPaise: true },
  });
  const result: OwedReceiptsResult = {
    checked: rows.length,
    handled: 0,
    failedIds: [],
  };
  for (const row of rows) {
    // The caller reports failures once per run, so this skips the per-call report.
    const receipt = await buildReceipt({
      purchaseId: row.id,
      buyerId: row.buyerId,
      productId: row.productId,
      amountPaise: row.amountPaise,
    }).catch((error: unknown) => {
      result.firstError ??= error;
      return null;
    });
    if (!receipt || receipt.prepared.failed > 0) {
      result.failedIds.push(row.id);
      await prisma.digitalProductPurchase.updateMany({
        where: { id: row.id, receiptStagedAt: null },
        data: { reconciledAt: now },
      });
      continue;
    }
    // The retry-failed-emails sweep delivers what this stages.
    await prisma.$transaction((tx) => stageDigitalProductReceipt(tx, receipt));
    result.handled += 1;
  }
  return result;
}

/** After commit, attempt what the transaction staged; best effort. */
export async function flushDigitalProductReceipt(
  staged: StagedRecipientEmail[],
  budgetMs: number,
): Promise<void> {
  try {
    await flushNotificationsAfter(
      {
        emails: [
          {
            list: staged,
            emailType: MONEY_EMAIL_TYPES.DIGITAL_PRODUCT_PURCHASED,
            budgetMs,
          },
        ],
      },
      "digital-product.purchased",
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      op: "digital-product.purchase-email",
      level: "warning",
    });
  }
}
