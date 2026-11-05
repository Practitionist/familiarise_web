/**
 * An order with nothing left to charge (credits, a full discount, or both)
 * takes the no-gateway rail and succeeds at birth: gateways reject amount <= 0.
 * Org-sponsored orders have their own synthetic rail.
 */
export function isZeroAmountOrder(
  amountPaise: number,
  isOrgSponsoredPayment: boolean,
): boolean {
  return amountPaise === 0 && !isOrgSponsoredPayment;
}
