import { z } from "zod";

export const jobOutcomeSchema = z.enum([
  "success",
  "partial_failure",
  "failure",
  "held",
]);
export type JobOutcome = z.infer<typeof jobOutcomeSchema>;

const auditSchema = z.object({
  ok: z.unknown(),
  summary: z.object({ status: z.unknown() }).optional().catch(undefined),
});

const resultSchema = z.object({
  success: z.unknown(),
  overallSuccess: z.unknown(),
  ok: z.unknown(),
  skipped: z.unknown(),
  held: z.unknown(),
  failed: z.unknown(),
  orgErrors: z.unknown(),
  stillFailing: z.unknown(),
  errorCount: z.unknown(),
  exhaustedReported: z.unknown(),
  errors: z.unknown(),
  report: auditSchema.optional().catch(undefined),
  summary: z.object({ status: z.unknown() }).optional().catch(undefined),
});

function positive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/** Interpret existing worker counters without treating remaining work as failure. */
export function jobOutcome(result: unknown): JobOutcome {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return "success";
  const value = parsed.data;
  if (value.success === false || value.overallSuccess === false)
    return "failure";
  if (
    positive(value.failed) ||
    positive(value.orgErrors) ||
    positive(value.stillFailing) ||
    positive(value.errorCount) ||
    positive(value.exhaustedReported) ||
    (Array.isArray(value.errors)
      ? value.errors.length > 0
      : positive(value.errors)) ||
    (value.ok === false && value.summary?.status !== "RUNNING") ||
    (value.report?.ok === false && value.report.summary?.status !== "RUNNING")
  ) {
    return "partial_failure";
  }
  if (value.skipped === true || value.held === true) return "held";
  return "success";
}
