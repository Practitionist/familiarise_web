/**
 * The rails on which an organization's money paid. A card payment merely tagged
 * to an org is the member's own money. Prisma-free so client components may import it.
 */
export const ORG_FUNDED_PAYMENT_METHODS = ["WALLET", "INVOICE", "LICENSE"];

export function isOrgFundedPaymentMethod(
  method: string | null | undefined,
): boolean {
  return ORG_FUNDED_PAYMENT_METHODS.includes(method ?? "");
}
