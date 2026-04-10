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
 * PROVIDER organizations (consultant agencies that host multiple consultants
 * and capture a slice of every booking via a 3-way revenue split).
 *
 * The schema, role enum, code paths, and API routes for PROVIDER orgs all
 * exist in this codebase but are gated by this flag. When false (the default
 * pre-MVP):
 *   - POST /api/organizations rejects `kind === "PROVIDER"` with 501
 *   - POST /api/organizations/[id]/members rejects `role === "ORG_CONSULTANT"` with 501
 *   - The org-create dashboard form hides PROVIDER from the kind dropdown
 *   - /api/organizations/[id]/payouts, /payout-account, /consultants return 501
 *   - /dashboard/organization/[id]/{consultants,payouts} are unreachable (nav links hidden)
 *   - The earnings split in lib/payments/payouts/earnings-service.ts takes
 *     the BUYER (= unchanged) path even if the schema's `kind === PROVIDER`
 *
 * To enable for a real PROVIDER customer:
 *   1. Set `ENABLE_PROVIDER_ORGS=true` in the deployment environment
 *   2. Redeploy
 *   3. Verify the rejection paths above now succeed
 *   4. See Issue #646 for the full PROVIDER follow-up checklist
 *
 * The flag is intentionally NOT a runtime toggle — flipping it mid-stream
 * would mean some payments use BUYER split logic and others use PROVIDER,
 * which is a compliance nightmare.
 */
export const ENABLE_PROVIDER_ORGS =
  process.env.ENABLE_PROVIDER_ORGS === "true";
