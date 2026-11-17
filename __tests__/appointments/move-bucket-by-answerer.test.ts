/**
 * A pending move is filed by who must answer next: the proposer's own list
 * says "waiting on them", the other side's says "needs you" (answer the move).
 */

import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const NOW = new Date();
const DAY = 86_400_000;
const EXPERT = "u-expert";
const LEARNER = "u-learner";

const proposal = (initiatorRole: "CONSULTANT" | "CONSULTEE") => ({
  id: "rr-1",
  status: "PENDING_REVIEW",
  reason: null,
  expiresAt: new Date(NOW.getTime() + 2 * DAY),
  originStatus: "APPROVED",
  initiatorRole,
  initiatedById: initiatorRole === "CONSULTANT" ? EXPERT : LEARNER,
  proposedTimes: [
    {
      startsAt: new Date(NOW.getTime() + 3 * DAY),
      endsAt: new Date(NOW.getTime() + 3 * DAY + 3_600_000),
    },
  ],
});
const released = {
  id: "occ-1",
  appointmentId: "appt-1",
  startsAt: new Date(NOW.getTime() + DAY),
  endsAt: new Date(NOW.getTime() + DAY + 3_600_000),
  isTentative: true,
  completionStatus: "RESCHEDULED",
  deletedAt: null,
  meeting: null,
};
const plan = {
  title: "Strategy call",
  consultantProfile: {
    id: "cp-1",
    user: { id: EXPERT, name: "Hannah", image: null },
  },
};
const consultation = {
  id: "c-1",
  status: "PENDING",
  bookingSource: "REQUEST_SUBMITTED",
  pendingPaymentUrl: null,
  consultationPlan: plan,
  requestedBy: { user: { id: LEARNER, name: "Charlotte", image: null } },
};
const appointment = (initiatorRole: "CONSULTANT" | "CONSULTEE") => ({
  id: "appt-1",
  organizationId: null,
  occurrences: [released],
  payment: [
    {
      id: "p-1",
      paymentStatus: "SUCCEEDED",
      amount: 50_000,
      currency: "INR",
      refunds: [],
    },
  ],
  rescheduleRequests: [proposal(initiatorRole)],
});

const learnerRow = (by: "CONSULTANT" | "CONSULTEE", viewerId?: string) =>
  mapConsulteeEvents(
    {
      consultations: [{ ...consultation, appointment: appointment(by) }],
    } as unknown as TConsulteeEventsResponse,
    NOW,
    "Asia/Kolkata",
    viewerId,
  )[0];

const expertRow = (by: "CONSULTANT" | "CONSULTEE", viewerUserId?: string) =>
  mapConsultantAppointments(
    {
      consultantId: "cp-1",
      viewerUserId,
      appointments: [
        {
          ...appointment(by),
          appointmentType: "CONSULTATION",
          consultation,
        },
      ],
    } as unknown as Parameters<typeof mapConsultantAppointments>[0],
    NOW,
  )[0];

describe("a pending move is filed by who answers next", () => {
  it("the learner's own move waits on the expert", () => {
    expect(learnerRow("CONSULTEE", LEARNER)).toMatchObject({
      bucket: "waiting",
    });
  });

  it("the expert's move needs the learner, to answer it", () => {
    expect(learnerRow("CONSULTANT", LEARNER)).toMatchObject({
      bucket: "needsAction",
      needsActionReason: "ANSWER_MOVE",
    });
  });

  it("the expert's own move waits on the learner", () => {
    expect(expertRow("CONSULTANT", EXPERT)).toMatchObject({
      bucket: "waiting",
    });
  });

  it("the learner's move needs the expert, to answer it", () => {
    expect(expertRow("CONSULTEE", EXPERT)).toMatchObject({
      bucket: "needsAction",
      needsActionReason: "ANSWER_MOVE",
    });
  });

  it("before the session loads, the list's own side decides", () => {
    expect(learnerRow("CONSULTANT")).toMatchObject({
      needsActionReason: "ANSWER_MOVE",
    });
    expect(expertRow("CONSULTANT")).toMatchObject({ bucket: "waiting" });
  });
});
