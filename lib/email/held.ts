/**
 * The outbox `lastError` of a message the pre-launch guard withheld; its row is
 * DEAD_LETTER. Dependency-free so client-reachable modules can import it.
 */
export const HELD_PRE_LAUNCH = "held:pre-launch";
