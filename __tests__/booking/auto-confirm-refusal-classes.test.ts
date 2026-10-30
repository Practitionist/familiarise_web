/**
 * @jest-environment node
 */
import {
  autoConfirmRefusalIsFinal,
  autoConfirmTimesTaken,
  rescheduleProposeOutcome,
} from "@/lib/booking/reschedule-proposals";

const outcome = (reason: string) =>
  rescheduleProposeOutcome({
    autoConfirmed: false,
    hasProposal: true,
    autoConfirmReason: reason,
    releaseMessage: "released",
  }).code;

describe("which auto-confirm refusals drop the proposed times", () => {
  it.each([
    "LOCK_CONTENTION",
    "UNKNOWN_ERROR",
    "SEARCH_TIMEOUT",
    "BOOKING_LOCK_UNAVAILABLE",
    "APPOINTMENT_BUSY",
    "RESCHEDULE_STATE_CHANGED",
    "ILLEGAL_TRANSITION",
    "CHECKOUT_IN_PROGRESS",
    "SOMETHING_NEW",
  ])("keeps the times on a transient or unknown refusal (%s)", (reason) => {
    expect(autoConfirmRefusalIsFinal(reason)).toBe(false);
    expect(outcome(reason)).toBe("AWAITING_ANSWER");
  });

  it.each([
    "VALIDATION_ERROR",
    "AVAILABILITY_CHANGED",
    "NO_AVAILABILITY",
    "SLOT_SHORTAGE",
    "COLLABORATOR_UNAVAILABLE",
    "PERIOD_ENDED",
    "TOO_CLOSE_TO_START",
    "SESSION_HAS_REMEDY",
    "PROGRAM_CAP_EXHAUSTED",
  ])("drops them on a refusal about the times themselves (%s)", (reason) => {
    expect(autoConfirmRefusalIsFinal(reason)).toBe(true);
    expect(outcome(reason)).toBe("NOT_PLACEABLE");
  });

  it("sends both kinds of 'someone took that time' through the same withdraw path", () => {
    expect(autoConfirmTimesTaken("TIMES_TAKEN")).toBe(true);
    expect(autoConfirmTimesTaken("SLOT_TAKEN")).toBe(true);
    expect(autoConfirmRefusalIsFinal("SLOT_TAKEN")).toBe(false);
    expect(autoConfirmTimesTaken("LOCK_CONTENTION")).toBe(false);
  });
});
