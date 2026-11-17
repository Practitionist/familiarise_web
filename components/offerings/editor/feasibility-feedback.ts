/**
 * What the subscription plan save says about the expert's hours: warnings on a
 * save that went through, and the reasons on a 422 `PLAN_NOT_FEASIBLE` refusal.
 */
import { z } from "zod";

import { ApiResponseError } from "@/lib/fetch-helpers";

const ReasonsSchema = z.array(z.object({ message: z.string() }));
const SavedSchema = z.object({ feasibilityWarnings: ReasonsSchema });
const RefusedSchema = z.object({ reasons: ReasonsSchema });

/** The warnings a saved plan came back with; empty for every other offering type. */
export function feasibilityWarningsOf(saved: unknown): string[] {
  const parsed = SavedSchema.safeParse(saved);
  return parsed.success
    ? parsed.data.feasibilityWarnings.map((reason) => reason.message)
    : [];
}

/** The reasons a publish was refused as undeliverable; null for any other error. */
export function feasibilityRefusalOf(error: unknown): string[] | null {
  if (!(error instanceof ApiResponseError)) return null;
  if (error.code !== "PLAN_NOT_FEASIBLE") return null;
  const parsed = RefusedSchema.safeParse(error.body);
  return parsed.success
    ? parsed.data.reasons.map((reason) => reason.message)
    : [];
}

/** The failed-save toast title: what the click was, and why when the hours refused it. */
export function saveFailedTitle(args: {
  publish: boolean;
  wasPublished: boolean;
  notFeasible: boolean;
}): string {
  if (args.notFeasible) return "Your open hours can't fit this plan";
  if (args.wasPublished) return "Couldn't save your changes";
  return args.publish ? "Couldn't publish" : "Couldn't save the draft";
}
