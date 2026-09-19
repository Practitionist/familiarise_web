/**
 * @jest-environment node
 */

/**
 * #1319 — the status writes that bypassed the CAS helpers. Each site below is
 * pinned at the source level: the guard has to be in the WHERE (or the helper
 * has to be called), never re-implemented as a read-then-write. Cheap, and it
 * catches a revert during a merge conflict that a mocked unit test would miss.
 */

import fs from "fs";
import path from "path";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("group-event status writes go through the CAS helpers", () => {
  it("webinars crud-with-plan never writes a client status with a bare update", () => {
    const src = read("app/api/bookings/webinars/crud-with-plan/route.ts");
    expect(src).not.toMatch(/webinarUpdateData\.status\s*=/);
    expect(src).toContain("transitionWebinarEvent(");
    expect(src).toContain("EVENT_PUBLISHABLE_FROM");
    expect(src).toContain("instanceof IllegalTransitionError");
  });

  it("classes crud-with-plan never writes a client status with a bare update", () => {
    const src = read("app/api/bookings/classes/crud-with-plan/route.ts");
    expect(src).not.toMatch(/classUpdateData\.status\s*=/);
    expect(src).toContain("transitionClassEvent(");
    expect(src).toContain("instanceof IllegalTransitionError");
  });

  it("auto-complete marks webinars/classes COMPLETED only from the allowed set", () => {
    const src = read("scripts/appointments/auto-complete-appointments.ts");
    expect(src).not.toMatch(/prisma\.webinar\.update\(/);
    expect(src).not.toMatch(/prisma\.class\.update\(/);
    expect(src).not.toMatch(/prisma\.trial\.update\(/);
    expect(src).toContain("EVENT_ALLOWED_FROM.COMPLETED");
    expect(src).toContain("transitionTrial(");
  });
});

describe("sweeps cancel only from a cancellable state", () => {
  it("cleanup-invalid-appointments CASes each request before releasing its slots, in one tx", () => {
    const src = read("scripts/appointments/cleanup-invalid-appointments.ts");
    // Four sweeps, one helper: the request CAS (CANCELLABLE_FROM) commits
    // first and the slot release is scoped to that request, inside one tx.
    expect(
      (
        src.match(
          /cancelRequestsAndReleaseSlots\(\s*"(consultation|subscription)"/g,
        ) ?? []
      ).length,
    ).toBe(4);
    expect((src.match(/fromIn: CANCELLABLE_FROM/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/transitionOccurrenceCompletion\(prisma,/);
  });

  // #1589 P-P1-01 / #1732 — cleanup-stale-pending-consultations is retired:
  // it CANCELLED the approved-but-unpaid cohort that expire-stale-requests
  // and the pay-link sweep EXPIRE (doctrine rule 5, one terminal word).
  it("the retired stale-pending-consultations sweep does not come back", () => {
    for (const file of [
      "scripts/appointments/cleanup-stale-pending-consultations.ts",
      "app/api/cleanup/stale-pending-consultations/route.ts",
      // The scheduled entry points too: a reintroduced wrapper or workflow
      // would re-arm the retired sweep without either file above.
      "jobs/appointments/cleanup-stale-pending-consultations.ts",
      ".github/workflows/cleanup-stale-pending-consultations.yml",
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(false);
    }
  });
});

describe("slot completion writers use transitionOccurrenceCompletion", () => {
  for (const file of [
    "lib/stream/session-handlers.ts",
    "jobs/meetings/reconcile-orphaned-sessions.ts",
    "actions/maintenance/drain-sessions.ts",
  ]) {
    it(`${file} has no bare completionStatus write`, () => {
      const src = read(file);
      expect(src).not.toMatch(
        /appointmentOccurrence\.update\(\{[\s\S]*?completionStatus/,
      );
      expect(src).toContain("transitionOccurrenceCompletion(");
    });
  }
});

// #1583 A-P0-05 / A-P1-03 — the three sweeps that still wrote status with a
// raw updateMany (no history row, no tombstone on the released occurrence).
describe("moderation and the two sweeps write status through the helpers", () => {
  it("cancel-user-engagements cancels parents and tombstones occurrences through the helpers", () => {
    const src = read("lib/moderation/cancel-user-engagements.ts");
    // The one remaining updateMany is the tombstone of rows already
    // CANCELLED (no status moves), never a completionStatus write.
    expect(src).not.toMatch(
      /appointmentOccurrence\.updateMany\(\{[\s\S]*?data:\s*\{[^}]*completionStatus/,
    );
    expect(src).not.toMatch(
      /tx\.(consultation|subscription|webinar|class)\.updateMany\(/,
    );
    expect(src).toContain("transitionOccurrenceCompletion(");
    expect(src).toContain("data: { deletedAt: now }");
  });

  it("auto-complete completes every parent through its helper", () => {
    const src = read("scripts/appointments/auto-complete-appointments.ts");
    expect(src).not.toMatch(
      /prisma\.(consultation|subscription|webinar|class)\.updateMany\(/,
    );
    for (const helper of [
      "transitionWebinarEvent(",
      "transitionClassEvent(",
      "transitionConsultationRequest(",
      "transitionSubscriptionRequest(",
    ]) {
      expect(src).toContain(helper);
    }
  });

  it("detect-consultant-no-shows tombstones the released occurrences", () => {
    const src = read("scripts/appointments/detect-consultant-no-shows.ts");
    expect(src).not.toMatch(/appointmentOccurrence\.updateMany\(/);
    expect(src).toContain("transitionOccurrenceCompletion(");
  });
});

describe("trial status writers use transitionTrial", () => {
  it("the trial route never writes status with a bare update", () => {
    const src = read("app/api/trials/[trialId]/route.ts");
    expect(src).not.toMatch(
      /trial\.update\(\{\s*where: \{ id: trialId \},\s*data: \{\s*status:/,
    );
    expect(
      (src.match(/transitionTrial\(/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("checkout converts a trial through the helper", () => {
    const src = read("lib/payments/operations/checkout.ts");
    expect(src).not.toMatch(/status: TrialStatus\.CONVERTED/);
    expect(src).toContain("to: TrialStatus.CONVERTED");
  });
});

describe("admin refunds use the booking front door", () => {
  it("the single-payment arm calls refundBookingPayment, never raw refundPayment", () => {
    const src = read("app/api/admin/refunds/route.ts");
    expect(src).not.toMatch(/\brefundPayment\(/);
    expect(src).toContain("refundBookingPayment(");
  });
});
