import prisma from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import {
  MONEY_EMAIL_TYPES,
  stageDigitalProductPurchaseEmail,
} from "@/lib/email/senders/money";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Email the buyer that a SUCCEEDED purchase is in their library. Called after
 * the settling commit; best effort, so a failure never touches the sale.
 */
export async function notifyDigitalProductPurchase(
  where: { id: string } | { paymentId: string },
  budgetMs: number,
): Promise<void> {
  try {
    const purchase = await prisma.digitalProductPurchase.findUnique({
      where,
      select: {
        id: true,
        status: true,
        buyerId: true,
        amountPaise: true,
        buyer: { select: { consulteeProfileId: true } },
        product: {
          select: {
            slug: true,
            title: true,
            consultantProfile: { select: { user: { select: { name: true } } } },
          },
        },
      },
    });
    if (purchase?.status !== "SUCCEEDED") return;
    const staged = await stageDigitalProductPurchaseEmail({
      purchaseId: purchase.id,
      buyerId: purchase.buyerId,
      productTitle: purchase.product.title,
      creatorName: purchase.product.consultantProfile.user.name,
      amountPaise: purchase.amountPaise,
      libraryHref: purchase.buyer.consulteeProfileId
        ? goHref("client", "products")
        : `/explore/products/${purchase.product.slug}`,
    });
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
      extra: where,
    });
  }
}
