/**
 * #1163 / #1169 PR 4 (API half) — the reschedule response loop exists and the
 * lifecycle stops mislabeling actors and dead-ending refunds.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const respondModule = read("lib/booking/reschedule-respond.ts");
const respondRoute = read(
  "app/api/appointments/[appointmentId]/reschedule/respond/route.ts",
);
const cancelRoute = read("app/api/appointments/[appointmentId]/cancel/route.ts");
const rescheduleRoute = read(
  "app/api/appointments/[appointmentId]/reschedule/route.ts",
);
const consulteeRead = read("lib/data/consultee-events-read.ts");

describe("#1163 — the counterparty can answer a proposal", () => {
  it("accept re-validates through the full allocator, nothing hand-written", () => {
    expect(respondModule).toContain("SlotAllocationService.allocate");
    expect(respondModule).toContain('mode: "manual"');
    expect(respondModule).toContain("wideLock: true");
    expect(respondModule).toContain('to: "ACCEPTED"');
  });

  it("decline is a CAS transition that leaves released slots released", () => {
    expect(respondModule).toContain('to: "DECLINED"');
    expect(respondModule).not.toContain('completionStatus: "SCHEDULED" }');
  });

  it("the respond route keeps the withdraw route's anti-oracle 404 discipline", () => {
    expect(respondRoute).toContain("No open reschedule request for this booking.");
    expect(respondRoute).toContain("open.initiatedById !== session.user.id");
  });

  it("the consultee read now carries the live proposal", () => {
    expect(consulteeRead).toContain("rescheduleRequests: {");
    expect(consulteeRead).toContain("proposedSlots");
  });
});

describe("#1166 — org admins act on the payer side of the lifecycle", () => {
  it("cancel authorizes the funding org's admins", () => {
    expect(cancelRoute).toContain("isOrgAdminOfAppointment(");
    expect(cancelRoute).toContain("!isOrgAdminActor");
  });

  it("reschedule authorizes them with consultee-role semantics", () => {
    expect(rescheduleRoute).toContain("isOrgAdminOfAppointment(");
    expect(rescheduleRoute).toContain('initiatorRole = "CONSULTEE"');
  });
});

describe("#1006 — linear per-session proration replaces the ₹0 escalation", () => {
  it("tiers the undelivered share, not the whole price", () => {
    expect(cancelRoute).toContain("proratedBasePaise");
    expect(cancelRoute).toContain("bookingCtx.sessionsRemaining");
    expect(cancelRoute).not.toContain("SUBSCRIPTION_PRORATION_UNDEFINED");
  });
});

describe("#1161 — the cancel route sends credit-funded bookings to the front door", () => {
  it("detects free_ intents and restores in full-refund windows", () => {
    expect(cancelRoute).toContain("isFreeCreditFunded");
    expect(cancelRoute).toContain(
      'paidPayment.paymentIntent.startsWith("free_")',
    );
    expect(cancelRoute).toContain("FREE_CREDIT_PARTIAL_RESTORATION_UNDEFINED");
  });
});

describe("lifecycle hygiene", () => {
  it("the cancel activity log carries a system arm", () => {
    expect(cancelRoute).toContain('("system" as const)');
  });

  it("removed attendees lose event-channel access", () => {
    for (const rel of [
      "app/api/participants/webinar/[webinarId]/route.ts",
      "app/api/participants/class/[classId]/route.ts",
    ]) {
      expect(read(rel)).toContain("removeUserFromEventChannel(");
    }
  });

  it("the booked notification carries the session time (#1085)", () => {
    expect(read("lib/payments/webhooks/handlers.ts")).toContain(
      "dateTime: firstSlot?.startsAt.toISOString()",
    );
  });
});
