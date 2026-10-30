import prisma from "@/lib/prisma";
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
 * transaction, staged inside it, and attempted after commit. A staged row the
 * attempt never reached is delivered by the email retry sweep.
 */

export type DigitalProductReceipt = PreparedDigitalProductPurchaseEmail;

/** Render the receipt for a purchase about to be settled or claimed; null when it cannot be built. */
export async function prepareDigitalProductReceipt(input: {
  purchaseId: string;
  buyerId: string;
  productId: string;
  amountPaise: number;
}): Promise<DigitalProductReceipt | null> {
  try {
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

/** Stage the receipt inside the transaction that settles or claims the purchase. */
export function stageDigitalProductReceipt(
  tx: ReceiptStagingTx,
  receipt: DigitalProductReceipt | null,
): Promise<StagedRecipientEmail[]> {
  return receipt
    ? stageDigitalProductPurchaseEmail(tx, receipt)
    : Promise.resolve([]);
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
