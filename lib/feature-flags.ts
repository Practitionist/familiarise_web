/**
 * Feature flags for gradual feature rollout.
 * Read from process.env at module load time; changing a flag requires a redeploy.
 */

/** Hosting organizations (3-way revenue split, `canHost`, `MemberRole.EXPERT`). */
export const ENABLE_HOST_ORGS = process.env.ENABLE_HOST_ORGS === "true";

/** Live payout disbursement gate (#776 §B). */
export const ENABLE_LIVE_PAYOUTS = process.env.ENABLE_LIVE_PAYOUTS === "true";

/** Section 194-O gross withholding base (#1132). */
export const ENABLE_TDS_194O_GROSS =
  process.env.ENABLE_TDS_194O_GROSS === "true";

/** Admin TDS dashboard + Form 26Q filing surfaces (#737). */
export const ENABLE_TDS_ADMIN_VIEW =
  process.env.ENABLE_TDS_ADMIN_VIEW === "true";

/** Better Stack Telemetry sink for operational events (#776 §K). */
export const ENABLE_BETTERSTACK_TELEMETRY =
  process.env.ENABLE_BETTERSTACK_TELEMETRY === "true";

/** Dunning stage-3 booking-suspend cascade (#812). */
export const ENABLE_DUNNING_SUSPEND =
  process.env.ENABLE_DUNNING_SUSPEND === "true";

/** Saved cards at checkout (#1771 row 1). */
export const ENABLE_SAVED_CARDS = process.env.ENABLE_SAVED_CARDS === "true";

/** Bank EMI at checkout (#1780 row 1). */
export const ENABLE_CHECKOUT_EMI = process.env.ENABLE_CHECKOUT_EMI === "true";
