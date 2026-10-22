import { z } from "zod";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const text = z.preprocess(
  blankToUndefined,
  z.string().trim().max(200).optional(),
);

/** An ISO instant, or a `YYYY-MM-DD` date read as UTC midnight. */
const instant = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .max(64)
    .refine((value) => !Number.isNaN(Date.parse(value)), "Not a date")
    .optional(),
);

/** The Audit tab's filters, from its inputs, its URL or the API query. */
export const OpsLogFiltersSchema = z.object({
  actorUserId: text,
  surface: text,
  targetKind: text,
  targetId: text,
  action: text,
  since: instant,
});

export type OpsLogFilters = z.infer<typeof OpsLogFiltersSchema>;

const FILTER_KEYS = OpsLogFiltersSchema.keyof().options;

/** Filters from a page URL: a bad value drops that filter rather than the page. */
export function opsLogFiltersFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): OpsLogFilters {
  const filters: OpsLogFilters = {};
  for (const key of FILTER_KEYS) {
    const raw = searchParams[key];
    const parsed = OpsLogFiltersSchema.shape[key].safeParse(
      Array.isArray(raw) ? raw[0] : raw,
    );
    if (parsed.success && parsed.data !== undefined) filters[key] = parsed.data;
  }
  return filters;
}
