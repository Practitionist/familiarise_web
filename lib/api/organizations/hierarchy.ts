/**
 * Organization hierarchy helpers — SCHEMA-ONLY in v1.
 *
 * The Organization model carries `parentId`, `rootId`, and `depth` columns
 * so a future multi-BU (Wipro-style) rollout lands without a migration.
 * Per AskUserQuestion decision, NO UI ships in v1 — these helpers are
 * used by:
 *
 *   - `prisma/seedFiles/15a-create-organizations.ts` to seed a root for
 *     each seeded org (rootId = id for root orgs).
 *   - Future reporting cron jobs that roll up child-org spend.
 *
 * The helpers below are REAL (not stubs) — they just have no caller yet.
 *
 * Design notes:
 *   - `rootId` is denormalised to support fast tenancy filters without
 *     recursive CTEs in hot paths.
 *   - `depth` is denormalised similarly; root = 0.
 *   - Re-parenting (moving a subtree under a new root) requires updating
 *     every descendant's rootId + depth. Not implemented in v1.
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Compute rootId + depth for a new organization.
 *
 * @param parentId - id of parent org, or null for top-level.
 * @returns `{ rootId, depth }` — if parent is null, rootId must be set to
 *   the new org's own id after creation. Caller handles the
 *   "self-pointing rootId" case via a two-step insert (create then update).
 */
export async function deriveHierarchyFromParent(
  prisma: PrismaClient,
  parentId: string | null,
): Promise<{ rootId: string | null; depth: number }> {
  if (!parentId) {
    return { rootId: null, depth: 0 };
  }
  const parent = await prisma.organization.findUnique({
    where: { id: parentId },
    select: { rootId: true, depth: true },
  });
  if (!parent) {
    throw new Error(`Parent organization ${parentId} not found`);
  }
  return { rootId: parent.rootId, depth: parent.depth + 1 };
}

/**
 * Return the root org id for the given org. For flat (rootId == id) orgs,
 * this just returns the input id.
 */
export async function rootIdOf(
  prisma: PrismaClient,
  orgId: string,
): Promise<string> {
  const row = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { rootId: true },
  });
  if (!row) throw new Error(`Organization ${orgId} not found`);
  return row.rootId;
}

/**
 * Return all descendant org ids (non-recursive; uses rootId filter).
 * Includes the root itself.
 */
export async function descendantIdsOf(
  prisma: PrismaClient,
  orgId: string,
): Promise<string[]> {
  const rootId = await rootIdOf(prisma, orgId);
  const descendants = await prisma.organization.findMany({
    where: { rootId },
    select: { id: true },
  });
  return descendants.map((d) => d.id);
}
