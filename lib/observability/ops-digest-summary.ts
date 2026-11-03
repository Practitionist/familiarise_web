import { z } from "zod";
import { releaseLagSchema } from "@/lib/observability/release-lag";

/** The registry slug and run-row name of the daily ops digest. */
export const OPS_DIGEST_JOB = "ops-digest";

const count = z.number().int().nonnegative();

const standingSkipSchema = z.object({
  jobName: z.string(),
  tier: z.enum(["paging", "watched"]),
  reason: z.string().nullable(),
  firstSeenAt: z.string().datetime(),
});

/** The digest's run-row summary; `/api/health/jobs` parses it instead of recomputing. */
const opsDigestSummarySchema = z.object({
  success: z.boolean(),
  heartbeat: z.enum(["pinged", "pinged-fail", "ping-failed", "not-configured"]),
  headline: z.string(),
  newItems: count,
  standingItems: count,
  unavailableSections: z.array(z.string()),
  standingSkips: z.array(standingSkipSchema),
  releaseLag: releaseLagSchema,
});
export type OpsDigestSummary = z.infer<typeof opsDigestSummarySchema>;

/** The `result` of a digest run row, as `cleanupRoute` stores it. */
export const opsDigestRunResultSchema = z.object({
  summary: opsDigestSummarySchema,
});
