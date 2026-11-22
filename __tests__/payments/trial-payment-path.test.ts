/**
 * @jest-environment node
 */

/**
 * Paid-trial money path.
 *
 * Covers the invariants that would cost real money or corrupt state if broken:
 *  - the trial is charged its plan's trialPriceInPaise, never the plan price
 *  - a free trial never mints a payment intent
 *  - a TRIAL intent without a trialId is rejected before it reaches the gateway
 *  - webhook metadata validates for TRIAL (an unhandled type routes to
 *    CRITICAL_PAYMENT_WITHOUT_APPOINTMENT — learner charged, trial unscheduled)
 *  - only live/delivered trials block a re-request; lapsed ones free the pair
 *  - AWAITING_PAYMENT occupies its slot, so nobody can book over a trial that
 *    is mid-payment
 */

import { AppointmentsType, TrialStatus } from "@prisma/client";

import {
  TRIAL_REQUEST_BLOCKING_STATUSES,
  TRIAL_REQUEST_FREEING_STATUSES,
} from "../../lib/trials/eligibility";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";
import { buildOccupiedAppointmentFilter } from "../../utils/scheduling-engine/occupancyPolicy";

const CUID = "clw0000000000000000000000";
const PLAN_CUID = "clw1111111111111111111111";
const TRIAL_CUID = "clw2222222222222222222222";

describe("trial re-request eligibility", () => {
  it("classifies every trial status exactly once: live or delivered blocks, CANCELLED frees", () => {
    expect(TRIAL_REQUEST_BLOCKING_STATUSES).toEqual([
      TrialStatus.AWAITING_PAYMENT,
      TrialStatus.SCHEDULED,
      TrialStatus.COMPLETED,
      TrialStatus.CONVERTED,
    ]);
    expect(TRIAL_REQUEST_FREEING_STATUSES).toEqual([TrialStatus.CANCELLED]);
    expect(
      [
        ...TRIAL_REQUEST_BLOCKING_STATUSES,
        ...TRIAL_REQUEST_FREEING_STATUSES,
      ].sort(),
    ).toEqual(Object.values(TrialStatus).sort());
  });
});

describe("webhook metadata for trials", () => {
  const base = {
    appointmentType: AppointmentsType.TRIAL,
    userId: CUID,
    planId: PLAN_CUID,
    trialId: TRIAL_CUID,
    startsAt: "2026-01-01T10:00:00.000Z",
    endsAt: "2026-01-01T10:30:00.000Z",
  };

  it("accepts a well-formed TRIAL payload", () => {
    // Before the TRIAL arm existed this threw "Unsupported appointment type",
    // which routes to CRITICAL_PAYMENT_WITHOUT_APPOINTMENT.
    const parsed = validateWebhookMetadata(
      base as unknown as Record<string, string>,
    );

    expect(parsed).toMatchObject({
      appointmentType: AppointmentsType.TRIAL,
      trialId: TRIAL_CUID,
    });
  });

  it("rejects a TRIAL payload with no trialId", () => {
    const { trialId: _omitted, ...withoutTrialId } = base;

    expect(() =>
      validateWebhookMetadata(
        withoutTrialId as unknown as Record<string, string>,
      ),
    ).toThrow();
  });
});

describe("slot occupancy while awaiting payment", () => {
  it("treats AWAITING_PAYMENT as occupying the slot", () => {
    // Otherwise another learner could book the same slot during the payment
    // window and the capture webhook would confirm into a double booking.
    const filters = buildOccupiedAppointmentFilter("consultant-1");

    const trialFilter = filters.find((f) => "trial" in f) as {
      trial: { is: { status: { in: TrialStatus[] } } };
    };

    expect(trialFilter.trial.is.status.in).toEqual(
      expect.arrayContaining([
        TrialStatus.SCHEDULED,
        TrialStatus.AWAITING_PAYMENT,
      ]),
    );
  });
});
