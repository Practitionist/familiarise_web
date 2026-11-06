/**
 * @jest-environment node
 */

/** Checkout names a weeks plan's price for the whole plan and pluralises lengths. */
import {
  planDurationText,
  planPriceLabel,
} from "@/lib/offerings/plan-length-copy";

it.each([
  [{ durationInWeeks: 26, durationInMonths: 6 }, "26 weeks", "Plan price"],
  [{ durationInWeeks: 1, durationInMonths: 1 }, "1 week", "Plan price"],
  [{ durationInWeeks: null, durationInMonths: 1 }, "1 month", "Monthly Fee"],
  [{ durationInWeeks: null, durationInMonths: 3 }, "3 months", "Monthly Fee"],
  [{}, "1 month", "Monthly Fee"],
])("%o reads %s, priced as %s", (plan, length, label) => {
  expect(planDurationText(plan)).toBe(length);
  expect(planPriceLabel(plan)).toBe(label);
});
