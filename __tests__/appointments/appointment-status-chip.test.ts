/**
 * The status chip on every appointments surface reads the one booking status:
 * a seat says "Registered", a 1:1 "Confirmed", and nothing says "Pending".
 */

import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import type { AppointmentVM } from "@/lib/appointments/view-model";

type ChipInput = Parameters<typeof appointmentStatusChip>[0];

function chip(
  vm: Partial<ChipInput>,
  role: "consultee" | "consultant" = "consultee",
): string {
  return appointmentStatusChip(
    { status: "APPROVED", kind: "CONSULTATION", ...vm } as ChipInput,
    role,
  ).label;
}

describe("appointmentStatusChip", () => {
  it.each([
    ["CONSULTATION", "APPROVED"],
    ["SUBSCRIPTION", "APPROVED"],
    ["TRIAL", "SCHEDULED"],
  ] as const)("a booked %s (%s) reads Confirmed", (kind, status) => {
    expect(chip({ kind, status })).toBe("Confirmed");
  });

  it.each(["WEBINAR", "CLASS"] as const)(
    "a %s seat reads Registered",
    (kind) => {
      expect(chip({ kind, status: "SCHEDULED" })).toBe("Registered");
    },
  );

  it("speaks the seven words, never a stored status", () => {
    expect(
      chip({ status: "PENDING", bookingSource: "REQUEST_SUBMITTED" }),
    ).toBe("Requested");
    expect(chip({ status: "APPROVED_PENDING_PAYMENT" })).toBe(
      "Awaiting payment",
    );
    expect(chip({ status: "REJECTED" })).toBe("Cancelled");
    expect(chip({ status: "EXPIRED" })).toBe("Cancelled");
    expect(chip({ status: "COMPLETED" })).toBe("Completed");
  });

  it("a pay-first hold is awaiting payment, not a request", () => {
    const hold: Partial<AppointmentVM> = {
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      payDeadline: new Date(Date.now() + 10 * 60_000),
    };
    expect(chip(hold)).toBe("Awaiting payment");
    expect(chip({ ...hold, payDeadline: null })).toBe("Cancelled");
  });

  it("an open reschedule reads Being moved", () => {
    expect(
      chip({
        reschedule: {
          by: "CONSULTANT",
          proposedStartsAt: null,
          originalStartsAt: null,
          expiresAt: null,
        },
      }),
    ).toBe("Being moved");
  });

  it("the host sees their own webinar or class in event words", () => {
    expect(chip({ kind: "WEBINAR", status: "SCHEDULED" }, "consultant")).toBe(
      "Scheduled",
    );
    expect(chip({ kind: "CLASS", status: "DRAFT" }, "consultant")).toBe(
      "Draft",
    );
    expect(chip({}, "consultant")).toBe("Confirmed");
  });
});
