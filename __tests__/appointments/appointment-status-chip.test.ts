/**
 * The learner's status chip, shared by Home, Appointments and the detail page:
 * a booked webinar or class reads "Registered", a booked 1:1 "Confirmed", and a
 * live event reads "In progress" once its next session is inside the join window.
 */

import {
  CONSULTEE_JOIN_WINDOW_MS,
  appointmentStatusChip,
} from "@/lib/appointments/occurrences";
import type { AppointmentVM } from "@/lib/appointments/view-model";

const NOW = new Date("2026-11-10T04:00:00.000Z");
const DAY = 86_400_000;

type ChipInput = Pick<AppointmentVM, "status" | "kind" | "nextAt" | "bucket">;

function chip(
  vm: Partial<ChipInput>,
  role: "consultee" | "consultant" = "consultee",
): string {
  return appointmentStatusChip(
    {
      status: "SCHEDULED",
      kind: "CONSULTATION",
      nextAt: new Date(NOW.getTime() + DAY),
      bucket: "upcoming",
      ...vm,
    },
    role,
    NOW,
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

  it("a 1:1 stays Confirmed inside the join window: it has no live status", () => {
    expect(chip({ nextAt: new Date(NOW.getTime() + 10 * 60_000) })).toBe(
      "Confirmed",
    );
  });

  it.each(["WEBINAR", "CLASS"] as const)(
    "a %s seat reads Registered before and after the event goes live",
    (kind) => {
      expect(chip({ kind, status: "SCHEDULED" })).toBe("Registered");
      expect(
        chip({
          kind,
          status: "IN_PROGRESS",
          nextAt: new Date(NOW.getTime() + 18 * DAY),
        }),
      ).toBe("Registered");
    },
  );

  it("a live event inside the join window reads In progress", () => {
    expect(
      chip({
        kind: "WEBINAR",
        status: "IN_PROGRESS",
        nextAt: new Date(NOW.getTime() + CONSULTEE_JOIN_WINDOW_MS - 60_000),
      }),
    ).toBe("In progress");
  });

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
