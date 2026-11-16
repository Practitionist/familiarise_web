/** @jest-environment node */
/** What the removed learner is told of the decision, and when they may appeal it. */
import { removalOutcomeCopy } from "@/components/support/resolution/removal-outcome";
import { removalDecisionNotice } from "@/lib/support/conduct-removal-state";

it("does not offer an appeal of a decision in the learner's favour, and says the seat is not given back", () => {
  const won = removalOutcomeCopy(
    { reviewsRemoval: true, isAppeal: false },
    "OVERTURNED",
  );
  expect(won.appealable).toBe(false);
  expect(won.label).toBe("Removal overturned");
  expect(won.note).toMatch(/not given back/);
  expect(won.note).toMatch(/refunded/);

  const lost = removalOutcomeCopy(
    { reviewsRemoval: true, isAppeal: false },
    "UPHELD",
  );
  expect(lost.appealable).toBe(true);
  expect(lost.label).toBe("Removal upheld");

  expect(
    removalOutcomeCopy({ reviewsRemoval: false, isAppeal: false }, "NO_REMEDY"),
  ).toEqual({ appealable: true, label: null, note: null });
});

it("tells the learner of either outcome as a required removed-seat notice", () => {
  for (const outcome of ["OVERTURNED", "UPHELD"] as const) {
    const notice = removalDecisionNotice(outcome);
    expect(notice.required).toBe("SEAT_RELEASED");
    expect(notice.message.length).toBeGreaterThan(10);
  }
  expect(removalDecisionNotice("OVERTURNED").message).toMatch(/not given back/);
});
