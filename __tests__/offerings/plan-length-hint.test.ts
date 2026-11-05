/** The weeks picker's description closes the length summary with a full stop. */
import { weeksLengthHint } from "@/components/planner/components/form-fields/PlanLengthField";

it.each([
  [
    "26 weeks · 78 sessions",
    "26 weeks · 78 sessions. The price is for the whole plan.",
  ],
  [null, "Pick a length from 1 to 52 weeks. The price is for the whole plan."],
])("%s", (summary, hint) => {
  expect(weeksLengthHint(summary)).toBe(hint);
});
