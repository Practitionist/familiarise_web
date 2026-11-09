/**
 * @jest-environment node
 */

/** Checkout names a plan's price as covering the whole plan, in weeks or months, and pluralises lengths. */
import {
  planDurationText,
  planPriceLabel,
} from "@/lib/offerings/plan-length-copy";

it.each([
  [
    { durationInWeeks: 26, durationInMonths: 6 },
    "26 weeks",
    "Plan price (26 weeks)",
  ],
  [
    { durationInWeeks: 1, durationInMonths: 1 },
    "1 week",
    "Plan price (1 week)",
  ],
  [
    { durationInWeeks: null, durationInMonths: 1 },
    "1 month",
    "Plan price (1 month)",
  ],
  [
    { durationInWeeks: null, durationInMonths: 3 },
    "3 months",
    "Plan price (3 months)",
  ],
  [{}, "1 month", "Plan price (1 month)"],
])("%o reads %s, priced as %s", (plan, length, label) => {
  expect(planDurationText(plan)).toBe(length);
  expect(planPriceLabel(plan)).toBe(label);
});
