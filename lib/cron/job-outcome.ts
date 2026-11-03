import { z } from "zod";

export const jobOutcomeSchema = z.enum([
  "success",
  "partial_failure",
  "failure",
  "held",
]);
export type JobOutcome = z.infer<typeof jobOutcomeSchema>;

const resultSchema = z.object({
  success: z.unknown(),
  overallSuccess: z.unknown(),
  ok: z.unknown(),
  skipped: z.unknown(),
  held: z.unknown(),
  failed: z.unknown(),
  exhaustedReported: z.unknown(),
  errors: z.unknown(),
  summary: z.object({ status: z.unknown() }).optional().catch(undefined),
});

function positive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/** The item-failure counters alone, ignoring any verdict: what separates a partial run from a finding. */
export function hasItemFailures(result: unknown): boolean {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return false;
  const value = parsed.data;
  return (
    positive(value.failed) ||
    positive(value.exhaustedReported) ||
    (Array.isArray(value.errors) && value.errors.length > 0) ||
    (value.ok === false && value.summary?.status !== "RUNNING")
  );
}

/**
 * A job's own `success`/`overallSuccess` boolean is its verdict and outranks every counter;
 * counters only classify jobs that declare no verdict. Remaining work is never failure.
 */
export function jobOutcome(result: unknown): JobOutcome {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return "success";
  const value = parsed.data;
  if (value.success === false || value.overallSuccess === false)
    return "failure";
  if (value.skipped === true || value.held === true) return "held";
  if (
    typeof value.success === "boolean" ||
    typeof value.overallSuccess === "boolean"
  )
    return "success";
  return hasItemFailures(value) ? "partial_failure" : "success";
}
