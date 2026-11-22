/**
 * @jest-environment node
 */

/** A conduct removal's order marker on its case events reads as plain words to staff, and never reaches the learner. */
import {
  learnerCaseEventValues,
  readableCaseEvent,
} from "@/lib/support/case-event-copy";

const opened = {
  kind: "CREATED",
  fromValue: "removal-order:order_RzP123",
  toValue: "OPEN",
};
const joined = {
  kind: "REOPENED",
  fromValue: "removal-order:order_RzP456",
  toValue: null,
};

it("shows staff plain words for a removal's opening and join events, with no order id", () => {
  expect(readableCaseEvent(opened)).toEqual({
    fromValue: null,
    toValue: "OPEN",
    summary: "Removal case opened",
  });
  expect(readableCaseEvent(joined)).toEqual({
    fromValue: null,
    toValue: null,
    summary: "A new removal joined this review",
  });
  expect(
    readableCaseEvent({
      kind: "STATUS_CHANGED",
      fromValue: "OPEN",
      toValue: "RESOLVED",
    }),
  ).toEqual({ fromValue: "OPEN", toValue: "RESOLVED", summary: null });
});

it("never hands the learner the marker or the order id", () => {
  for (const event of [opened, joined]) {
    const values = learnerCaseEventValues(event);
    expect(JSON.stringify(values)).not.toMatch(/removal-order|order_RzP/);
  }
  expect(learnerCaseEventValues(opened)).toEqual({
    fromValue: null,
    toValue: "OPEN",
  });
});
