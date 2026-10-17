/** A Payment row written before its gateway order exists carries this intent prefix; no gateway knows it. */
export const PRE_MINT_INTENT_PREFIX = "premint_";

export function isPreMintIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith(PRE_MINT_INTENT_PREFIX);
}
