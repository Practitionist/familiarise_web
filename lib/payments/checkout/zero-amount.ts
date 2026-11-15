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

/**
 * A buyer-paid supply, and so a consumer tax invoice and a billing state,
 * exists only when money or credit funded the order: a free order needs neither.
 */
export function hasBilledSupply(
  amountPaise: number,
  creditsAppliedPaise: number,
): boolean {
  return amountPaise > 0 || creditsAppliedPaise > 0;
}
