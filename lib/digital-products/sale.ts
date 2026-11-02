import type { DigitalProductStatus, OrgPlanVisibility } from "@prisma/client";
import prisma from "@/lib/prisma";

export interface ProductForSale {
  id: string;
  consultantProfileId: string;
  organizationId: string | null;
  visibility: OrgPlanVisibility;
  status: DigitalProductStatus;
  takenDownAt: Date | null;
  pricePaise: number;
}

export type SaleRefusal =
  "NOT_FOUND" | "NOT_FOR_SALE" | "OWN_PRODUCT" | "ORG_MEMBERSHIP_REQUIRED";

export const SALE_REFUSAL_STATUS: Record<SaleRefusal, number> = {
  NOT_FOUND: 404,
  NOT_FOR_SALE: 409,
  OWN_PRODUCT: 400,
  ORG_MEMBERSHIP_REQUIRED: 403,
};

/** Whether this buyer may buy or claim the product right now, and on what price. */
export async function checkProductForSale(
  productId: string,
  buyer: { id: string; consultantProfileId?: string | null },
): Promise<
  { ok: true; product: ProductForSale } | { ok: false; code: SaleRefusal }
> {
  const product = await prisma.digitalProduct.findUnique({
    where: { id: productId },
    select: {
      id: true,
      consultantProfileId: true,
      organizationId: true,
      visibility: true,
      status: true,
      takenDownAt: true,
      pricePaise: true,
    },
  });
  if (!product) return { ok: false, code: "NOT_FOUND" };
  if (product.status !== "PUBLISHED" || product.takenDownAt) {
    return { ok: false, code: "NOT_FOR_SALE" };
  }
  if (
    buyer.consultantProfileId &&
    buyer.consultantProfileId === product.consultantProfileId
  ) {
    return { ok: false, code: "OWN_PRODUCT" };
  }
  if (product.visibility === "ORG_ONLY") {
    const member = product.organizationId
      ? await prisma.membership.findFirst({
          where: {
            userId: buyer.id,
            organizationId: product.organizationId,
            status: "ACTIVE",
          },
          select: { id: true },
        })
      : null;
    if (!member) return { ok: false, code: "ORG_MEMBERSHIP_REQUIRED" };
  }
  return { ok: true, product };
}
