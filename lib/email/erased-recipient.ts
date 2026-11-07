/** Erasure overwrites a stored recipient with this prefix and a digest; no send or replay may use it. */
export const ERASED_RECIPIENT_PREFIX = "erased:";

export function isErasedRecipient(recipient: string): boolean {
  return recipient.startsWith(ERASED_RECIPIENT_PREFIX);
}
