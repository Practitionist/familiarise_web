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
 *   - /dashboard/organization/[id]/{experts,payouts} nav links hidden
 *   - The earnings split in lib/payments/payouts/earnings-service.ts takes
 *     the sponsor-only path even if the org has `canHost=true`
 *
 * To enable for a real hosting org customer:
 *   1. Set `ENABLE_HOST_ORGS=true` in the deployment environment
 *   2. Redeploy
 *   3. Verify the rejection paths above now succeed
 *   4. See Issue #646 for the full hosting-org follow-up checklist
 *
 * The flag is intentionally NOT a runtime toggle — flipping it mid-stream
 * would mean some payments use sponsor-only split logic and others use
 * the 3-way split, which is a compliance nightmare.
 *
 * Renamed from `ENABLE_PROVIDER_ORGS` in the Arch-4 terminology purge —
 * "provider" is dead vocabulary; the capability is `canHost` and the
 * kind label is `HOST`. No back-compat shim because the app is pre-launch.
 */
export const ENABLE_HOST_ORGS = process.env.ENABLE_HOST_ORGS === "true";

/**
 * IRP (Invoice Registration Portal) live e-invoice integration.
 *
 * ClearTax GSP connector is wired (`lib/compliance/irp.ts`,
 * `jobs/compliance/irp-uploader.ts`) but live submission is gated until
 * CA/legal team signs off on production credentials and the >₹5cr AATO
 * threshold actually applies to the platform. The scheduled GitHub
 * Action (`.github/workflows/irp-uploader.yml`) short-circuits when this
 * flag is false so we don't burn CI minutes hitting a stubbed connector.
 *
 * Sub-₹5cr orgs ride along on the stub `{ status: "FAILED", reason: "STUB" }`
 * return and don't need IRN to claim ITC. When the platform crosses the
 * threshold (or onboards a customer who does):
 *   1. Set `ENABLE_IRP_UPLOADER=true` in the deployment environment
 *   2. Set CLEARTAX_API_KEY + CLEARTAX_GSP_TOKEN + CLEARTAX_GSTIN
 *      secrets on GitHub Actions
 *   3. Run the workflow once manually (workflow_dispatch) to confirm
 *   4. See Issue #713 for the full IRP rollout checklist
 */
export const ENABLE_IRP_UPLOADER = process.env.ENABLE_IRP_UPLOADER === "true";

/**
 * Admin TDS dashboard + Form 26Q filing surfaces.
 *
 * `app/api/admin/tds/route.ts` exposes TDS deduction summaries,
 * consultant-level breakdowns, and (ADMIN-only) decrypted PAN for the
 * Form 26Q quarterly filing. The data is captured continuously by the
 * payout pipeline, but the *filing workflow* (mark-as-filed, decrypted
 * PAN view) is gated until the finance team is ready to operate it.
 *
 * When false (default): the endpoint returns 404, hiding it from
 * casual discovery. Summary/breakdown can still be reached by other
 * surfaces that read TDSRecord directly if needed for reporting.
 *
 * To enable when finance is ready to file:
 *   1. Set `ENABLE_TDS_ADMIN_VIEW=true` in the deployment environment
 *   2. Confirm the assigned ADMIN's session has the decryption key
 *   3. See Issue #737 for the Form 26Q quarterly cadence
 */
export const ENABLE_TDS_ADMIN_VIEW = process.env.ENABLE_TDS_ADMIN_VIEW === "true";

/**
 * Better Stack Telemetry (logs) sink for operational events (#776 §K).
 *
 * `recordSystemEvent`/`recordSystemError` always write the `SystemEvent`
 * table (source of truth). When this flag is on AND `BETTERSTACK_SOURCE_TOKEN`
 * + `BETTERSTACK_INGEST_URL` are set, those recorders ALSO ship the event to
 * Better Stack Telemetry so a failed reconcile / stuck payout / webhook-queue
 * backlog / HMAC failure can actually page someone instead of rotting in a
 * table nobody queries.
 *
 * Off by default: the sink is a fire-and-forget side channel, never on the
 * critical path. To enable:
 *   1. Create a Telemetry source in Better Stack; copy its source token +
 *      ingesting host.
 *   2. Set `ENABLE_BETTERSTACK_TELEMETRY=true`, `BETTERSTACK_SOURCE_TOKEN`,
 *      and `BETTERSTACK_INGEST_URL` in the deployment environment.
 *   3. Redeploy and confirm events land on the source's live tail.
 */
export const ENABLE_BETTERSTACK_TELEMETRY =
  process.env.ENABLE_BETTERSTACK_TELEMETRY === "true";

