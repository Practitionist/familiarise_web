import { z } from "zod";

/**
 * The optional `startDate` / `endDate` pair the event list routes accept
 * (#1592 A-P1-04). ISO 8601 date-times only: `z.string().datetime()` refuses
 * both garbage and a calendar-impossible day such as 2026-02-30, which
 * `new Date()` would silently roll into March.
 */
export const listDateFilterSchema = z
  .object({
    startDateStr: z.string().datetime().nullable(),
    endDateStr: z.string().datetime().nullable(),
  })
  // Both or neither, and in order: a half-open range used to fall through to
  // an unfiltered list that answered 200 as if the filter had applied.
  .refine(({ startDateStr, endDateStr }) => !!startDateStr === !!endDateStr, {
    message: "startDate and endDate must be provided together",
  })
  .refine(
    ({ startDateStr, endDateStr }) =>
      !startDateStr ||
      !endDateStr ||
      new Date(startDateStr).getTime() <= new Date(endDateStr).getTime(),
    { message: "startDate must not be after endDate" },
  );
