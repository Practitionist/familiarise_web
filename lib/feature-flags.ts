/**
 * Feature flags for gradual feature rollout.
 *
 * Flags are read from process.env at module load time. Setting a flag in the
 * deployment environment requires a redeploy — this is intentional. We don't
 * want runtime flag flips for billing-affecting features.
 *
 * To enable a flag locally, add it to your `.env` file or set it in your
 * shell before running `npm run dev`.
 */

/**
 * Hosting organizations (agencies that host multiple experts and capture
 * a slice of every booking via a 3-way revenue split).
 *
 * The schema (`Organization.canHost`, `MemberRole.EXPERT`,
 * `OrganizationEarnings`), code paths, and API routes for hosting orgs
 * all exist in this codebase but are gated by this flag. When false (the
 * default pre-MVP):
 *   - POST /api/organizations rejects `canHost=true` with 501
 *   - POST /api/organizations/[id]/members rejects `role === "EXPERT"` with 501
 *   - The org-create wizard hides the "host experts" capability checkbox
 *   - /api/organizations/[id]/{payouts,payout-account,earnings,rate-cards}
 *     return 501
 *   - /dashboard/organization/[id]/{consultants,payouts} nav links hidden
 *   - The earnings split in lib/payments/payouts/earnings-service.ts takes
 *     the sponsor-only path even if the org has `canHost=true`
 *
 * To enable for a real hosting org customer:
 *   1. Set `ENABLE_PROVIDER_ORGS=true` in the deployment environment
 *   2. Redeploy
 *   3. Verify the rejection paths above now succeed
 *   4. See Issue #646 for the full hosting-org follow-up checklist
 *
 * The flag is intentionally NOT a runtime toggle — flipping it mid-stream
 * would mean some payments use sponsor-only split logic and others use
 * the 3-way split, which is a compliance nightmare.
 */
export const ENABLE_PROVIDER_ORGS =
  process.env.ENABLE_PROVIDER_ORGS === "true";
