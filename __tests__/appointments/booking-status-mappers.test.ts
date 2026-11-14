/**
 * One stored booking, one word: a pay-first hold reads "Awaiting payment"
 * through every mapper that builds the status input, and a seat the learner
 * left says so instead of blaming the host.
 */

import { staffStatus } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { bookingStatus } from "@/lib/appointments/booking-status";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import type { StaffAppointment } from "@/lib/data/staff-appointments";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const NOW = new Date();
const inFifteen = new Date(NOW.getTime() + 15 * 60_000);
const payment = {
  id: "pay-1",
  paymentStatus: "PENDING",
  expiresAt: inFifteen,
  amount: 50_000,
  currency: "INR",
  refunds: [],
};
const occurrence = {
  id: "occ-1",
  appointmentId: "appt-1",
  startsAt: new Date(NOW.getTime() + 86_400_000),
  endsAt: new Date(NOW.getTime() + 90_000_000),
  isTentative: true,
  completionStatus: "SCHEDULED",
  deletedAt: null,
  meeting: null,
};
const plan = {
  title: "Strategy call",
  consultantProfile: {
    id: "cp-1",
    user: { id: "u-e", name: "Hannah", image: null },
  },
};
const consultation = {
  id: "c-1",
  status: "PENDING",
  bookingSource: "DIRECT_CHECKOUT",
  pendingPaymentUrl: null,
  consultationPlan: plan,
  requestedBy: { user: { id: "u-l", name: "Charlotte", image: null } },
};

describe("a pay-first hold reads the same word on every surface", () => {
  it.each([
    [
      "the one status function",
      () =>
        bookingStatus(
          {
            kind: "CONSULTATION",
            status: "PENDING",
            source: "DIRECT_CHECKOUT",
            payDeadline: inFifteen,
          },
          "CONSULTEE",
        ).label,
    ],
    [
      "the learner's list",
      () => {
        const [vm] = mapConsulteeEvents(
          {
            consultations: [
              {
                ...consultation,
                appointment: {
                  id: "appt-1",
                  organizationId: null,
                  occurrences: [occurrence],
                  payment: [payment],
                },
              },
            ],
          } as unknown as TConsulteeEventsResponse,
          NOW,
        );
        return appointmentStatusChip(vm, "consultee").label;
      },
    ],
    [
      "the expert's list",
      () => {
        const [vm] = mapConsultantAppointments(
          {
            consultantId: "cp-1",
            appointments: [
              {
                id: "appt-1",
                appointmentType: "CONSULTATION",
                organizationId: null,
                occurrences: [occurrence],
                payment: [payment],
                consultation,
              },
            ],
          } as unknown as Parameters<typeof mapConsultantAppointments>[0],
          NOW,
        );
        return appointmentStatusChip(vm, "consultant").label;
      },
    ],
    [
      "the back office",
      () =>
        staffStatus({
          type: "consultation",
          status: "pending",
          bookingSource: "DIRECT_CHECKOUT",
          payment: { status: "PENDING" },
          reschedule: null,
        } as StaffAppointment).label,
    ],
  ])("%s", (_surface, read) => {
    expect(read()).toBe("Awaiting payment");
  });
});

describe("a released seat names what happened", () => {
  const seat = (eventStatus: string) =>
    bookingStatus(
      {
        kind: "WEBINAR",
        status: eventStatus,
        seatStatus: "CANCELLED",
        seatReleasedAt: new Date("2026-11-13T10:00:00Z"),
      },
      "CONSULTEE",
      { zone: "UTC" },
    ).line;

  it("leaving a running event is a released place, not a host cancel", () => {
    expect(seat("SCHEDULED")).toBe(
      "Your place on this event was released on 13 Nov.",
    );
    expect(seat("CANCELLED")).toBe("This event was cancelled by the host.");
  });
});
