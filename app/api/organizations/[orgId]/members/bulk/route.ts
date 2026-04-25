/**
 * Explicit 405 stub for `/api/organizations/[orgId]/members/bulk`.
 *
 * Bulk member operations (multi-remove, multi-role-change, CSV import)
 * are intentionally NOT supported in v1. The single-member PATCH
 * endpoint at `/api/organizations/[orgId]/members/[memberId]` is the
 * only sanctioned mutation surface — that route runs the last-OWNER
 * anti-lockout guard inside a Serializable transaction, and a bulk
 * operation would either need to replicate that guard per-row (slow,
 * inconsistent) or skip it (lockout risk).
 *
 * Returning a deterministic 405 here closes the door on a future
 * accidental implementation that bypasses the lockout invariant.
 * docs/enterprise/26-deletion-policy.md is the source of truth.
 */

import { NextResponse } from "next/server";

const NOT_SUPPORTED = NextResponse.json(
  {
    error: "BULK_REMOVAL_NOT_SUPPORTED",
    message:
      "Bulk member operations are not supported. Use PATCH /api/organizations/<orgId>/members/<memberId> per member; the single-member route enforces the anti-lockout guard.",
  },
  { status: 405, headers: { Allow: "" } },
);

export const GET = () => NOT_SUPPORTED;
export const POST = () => NOT_SUPPORTED;
export const PUT = () => NOT_SUPPORTED;
export const PATCH = () => NOT_SUPPORTED;
export const DELETE = () => NOT_SUPPORTED;
