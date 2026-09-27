/**
 * Per-org MemberRole transition policy.
 *
 * The product rule is that LEARNER and EXPERT are disjoint roles:
 * a member cannot flip between consuming services and delivering
 * them within the same Membership. They should be removed and
 * re-invited under the new role, which forces a fresh Membership
 * row with the right profile FKs (ConsulteeProfile vs
 * ConsultantProfile) and a clean audit entry.
 *
 * The other role rules (operator roles switch freely, a LEARNER or
 * EXPERT with history here must be removed and re-invited, OWNER-only
 * roles, the last OWNER) live in `lib/enterprise/membership-guards.ts`,
 * which calls this for the blocked pairs. That guard is shared by the
 * members PATCH route, SCIM provisioning and bulk import (#1846).
 */

import type { MemberRole } from "@prisma/client";

const BLOCKED_PAIRS = new Set<string>([
  "LEARNER>EXPERT",
  "EXPERT>LEARNER",
]);

export function isBlockedRoleTransition(
  from: MemberRole,
  to: MemberRole,
): boolean {
  if (from === to) return false;
  return BLOCKED_PAIRS.has(`${from}>${to}`);
}
