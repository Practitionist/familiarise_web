/**
 * @jest-environment node
 */

/**
 * #1074 / #1319 — rule 2 of the booking doctrine, made durable.
 *
 * Nothing under scripts/ may hard-delete an Appointment, a request row, or a
 * SlotOfAppointment. A trial cancellation once deleted the appointment and
 * took the Payment row with it (#1074); the abandoned-payment sweep shipped the
 * same shape for another two months. This is a source-text contract: it fails
 * the moment a `delete`/`deleteMany` on those models is reintroduced, which a
 * mock-based test cannot promise.
 */

import fs from "fs";
import path from "path";

const SWEEPS = [
  "scripts/payments/cleanup-abandoned-payments.ts",
  "scripts/appointments/cleanup-invalid-appointments.ts",
  "scripts/appointments/cleanup-stale-pending-consultations.ts",
  "scripts/appointments/cleanup-tentative-slots.ts",
  "scripts/appointments/expire-stale-requests.ts",
  "scripts/appointments/auto-complete-appointments.ts",
];

const FORBIDDEN = [
  /\bconsultation\.delete\(/,
  /\bsubscription\.delete\(/,
  /\bappointment\.delete\(/,
  /\bappointment\.deleteMany\(/,
  /\bconsultation\.deleteMany\(/,
  /\bsubscription\.deleteMany\(/,
];

describe("no sweep hard-deletes a booking row (#1319)", () => {
  for (const file of SWEEPS) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");

    it(`${file} never deletes a request or appointment`, () => {
      for (const pattern of FORBIDDEN) {
        expect(source).not.toMatch(pattern);
      }
    });
  }

  it("the two sweeps that used to delete slots now soft-cancel them", () => {
    for (const file of [
      "scripts/payments/cleanup-abandoned-payments.ts",
      "scripts/appointments/cleanup-invalid-appointments.ts",
      "scripts/appointments/cleanup-stale-pending-consultations.ts",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/slotOfAppointment\.deleteMany\(/);
      expect(source).toContain("transitionSlotCompletion(");
    }
  });

  it("the unscheduled approval-payments route is gone (one semantics: EXPIRED)", () => {
    expect(
      fs.existsSync(
        path.join(process.cwd(), "app/api/cleanup/approval-payments/route.ts"),
      ),
    ).toBe(false);
    const sweep = fs.readFileSync(
      path.join(
        process.cwd(),
        "scripts/payments/cleanup-abandoned-payments.ts",
      ),
      "utf8",
    );
    // The lapsed-pay-link cohort expires; REJECTED would read as a decline.
    expect(sweep).not.toContain("AppointmentStatus.REJECTED");
  });
});
