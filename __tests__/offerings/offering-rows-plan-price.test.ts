/**
 * @jest-environment node
 */

/**
 * The Offerings list prices a weeks plan for the whole plan and a months plan
 * per month.
 */
import { buildOfferingRows } from "@/components/offerings/list/offering-rows";

const subscription = (plan: Record<string, unknown>) =>
  ({
    id: "evt",
    subscriptionPlan: {
      id: "plan",
      title: "Plan",
      status: "PUBLISHED",
      price: 1_560_000,
      priceCurrency: "INR",
      sessionsPerWeek: 3,
      sessionDurationInHours: 1,
      durationInMonths: 6,
      durationInWeeks: null,
      ...plan,
    },
  }) as never;

const priceOf = (plan: Record<string, unknown>) =>
  buildOfferingRows({
    consultationPlans: [],
    subscriptionPlans: [subscription(plan)],
    webinars: [],
    classes: [],
    participantCounts: {},
  })[0].priceText;

it.each([
  [{ durationInWeeks: 26 }, /^₹.*15,600\.00 for 26 weeks$/],
  [{ durationInWeeks: 1 }, /^₹.*15,600\.00 for 1 week$/],
  [{}, /^₹.*15,600\.00\/mo$/],
])("prices %o as %s", (plan, expected) => {
  expect(priceOf(plan)).toMatch(expected);
});
