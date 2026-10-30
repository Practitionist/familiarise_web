import {
  consulteeDestructiveAction,
  consulteeMayReschedule,
  openProposalTarget,
  type OpenRescheduleProposal,
} from "@/lib/appointments/consultee-affordances";

describe("#1005 consultee affordances", () => {
  it("allows reschedule only for 1:1 kinds", () => {
    expect(consulteeMayReschedule("CONSULTATION")).toBe(true);
    expect(consulteeMayReschedule("SUBSCRIPTION")).toBe(true);
    expect(consulteeMayReschedule("WEBINAR")).toBe(false);
    expect(consulteeMayReschedule("CLASS")).toBe(false);
    expect(consulteeMayReschedule("TRIAL")).toBe(false);
  });

  it("maps destructive actions by kind", () => {
    expect(consulteeDestructiveAction("CONSULTATION")).toBe("cancel-booking");
    expect(consulteeDestructiveAction("SUBSCRIPTION")).toBe("cancel-booking");
    expect(consulteeDestructiveAction("TRIAL")).toBe("cancel-trial");
    expect(consulteeDestructiveAction("WEBINAR")).toBe("leave-event");
    expect(consulteeDestructiveAction("CLASS")).toBe("leave-event");
  });
});

describe("#1163 open proposal detection", () => {
  const proposal = (round: number): OpenRescheduleProposal => ({
    id: `req-${round}`,
    status: "PENDING_REVIEW",
    reason: null,
    expiresAt: "2026-08-20T10:00:00.000Z",
    initiatorRole: "CONSULTANT",
    initiatedById: "user-1",
    proposedTimes: [
      {
        startsAt: "2026-08-21T10:00:00.000Z",
        endsAt: "2026-08-21T10:30:00.000Z",
      },
      {
        startsAt: "2026-08-22T10:00:00.000Z",
        endsAt: "2026-08-22T10:30:00.000Z",
      },
    ],
  });

  it("finds the proposal on whichever appointment carries it — not the anchor", () => {
    const target = openProposalTarget([
      { id: "anchor", rescheduleRequests: [] },
      undefined,
      { id: "sibling", rescheduleRequests: [proposal(1)] },
    ]);
    expect(target?.appointmentId).toBe("sibling");
    expect(target?.proposal.id).toBe("req-1");
  });

  it("returns null when nothing is open (the reads pre-narrow to open statuses)", () => {
    expect(openProposalTarget([{ id: "a" }, null, undefined])).toBeNull();
  });
});
