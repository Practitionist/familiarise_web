import type { MemberRole } from "@prisma/client";

/**
 * Display order for org roles — never an authorization input.
 *
 * Who may do what lives in the org permission matrix
 * (`lib/auth/org-permissions.ts`). The ladder used to gate routes too, and it
 * could not express the operations/finance track split: BILLING_ADMIN (70)
 * outranks MANAGER yet must see less, and MAINTAINER (80) outranks
 * BILLING_ADMIN yet holds no money write. #1851 moved every org gate onto
 * the matrix; a jest pin refuses a rank check under app/api/organizations.
 *
 * What still reads the numbers: picking the "most operator-like" org to land
 * on (`lib/labels/org-labels.ts`) and choosing one role when a SCIM user sits
 * in several mapped groups (`lib/scim/resource-user.ts`). Both are ordering
 * questions, not permission ones.
 *
 * The steps of ~20 leave room for a future role between two rungs without
 * renumbering the rest.
 */
export const ORG_ROLE_RANK: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  BILLING_ADMIN: 70,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};
