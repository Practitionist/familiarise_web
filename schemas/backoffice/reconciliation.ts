import { z } from "zod";

const jobKeySchema = z.enum([
  "ledgers",
  "refunds",
  "payment-status",
  "earnings",
]);
const ledgerStatusSchema = z.enum(["RUNNING", "FAILED", "COMPLETED"]);
export const ledgerSummarySchema = z.object({ status: ledgerStatusSchema });
const batchSchema = z.object({
  processed: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  full: z.boolean(),
});

export const reconcileOverviewSchema = z.object({
  jobs: z.array(
    z.object({
      key: jobKeySchema,
      label: z.string(),
      description: z.string(),
      last: z
        .object({
          status: z.enum(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
          startedAt: z.string().datetime(),
          endedAt: z.string().datetime().nullable(),
          errorCount: z.number().int().nullable(),
        })
        .nullable(),
    }),
  ),
  ledgerReport: z
    .object({
      id: z.string(),
      runAt: z.string().datetime(),
      ok: z.boolean(),
      scope: z.string(),
      status: ledgerStatusSchema.or(z.literal("UNKNOWN")),
    })
    .nullable(),
});

export const reconcileFeedbackSchema = z.object({
  job: jobKeySchema,
  batch: batchSchema.nullable().optional(),
});
export type ReconcileOverview = z.infer<typeof reconcileOverviewSchema>;
export type ReconcileJobRow = ReconcileOverview["jobs"][number];
export type ReconcileBatch = z.infer<typeof batchSchema>;
