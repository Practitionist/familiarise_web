/**
 * The learner's status chip, shared by Home, Appointments and the detail page:
 * a booked webinar or class reads "Registered" and a booked 1:1 "Confirmed".
 */

import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import type { AppointmentVM } from "@/lib/appointments/view-model";

type ChipInput = Pick<AppointmentVM, "status" | "kind" | "bucket">;

function chip(
  vm: Partial<ChipInput>,
  role: "consultee" | "consultant" = "consultee",
): string {
  return appointmentStatusChip(
    { status: "SCHEDULED", kind: "CONSULTATION", bucket: "upcoming", ...vm },
    role,
  ).label;
}

describe("appointmentStatusChip", () => {
  it.each([
    ["CONSULTATION", "SCHEDULED"],
    ["SUBSCRIPTION", "APPROVED"],
    ["SUBSCRIPTION", "SCHEDULED"],
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

  it("rows that are not booked-and-upcoming keep their status label", () => {
    expect(chip({ status: "APPROVED", bucket: "needsAction" })).toBe(
      "Approved",
    );
    expect(chip({ status: "SCHEDULED", bucket: "past" })).toBe("Scheduled");
    expect(chip({ status: "CANCELLED", bucket: "cancelled" })).toBe(
      "Cancelled",
    );
  });

  it("the consultant sees the plain status", () => {
    expect(chip({}, "consultant")).toBe("Scheduled");
    expect(chip({ kind: "WEBINAR" }, "consultant")).toBe("Scheduled");
  });
});
