/**
 * Returns a deterministic Stream channel ID for a consultant-consultee DM pair.
 * IDs are sorted so the same value is produced regardless of call order.
 */
export function getDmChannelId(userId1: string, userId2: string): string {
  const [a, b] = [userId1, userId2].sort();
  return `dm-${a}-${b}`;
}
