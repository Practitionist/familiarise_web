/**
 * A collaborator is busy at a co-hosted event through their Collaborator row,
 * never through a participant row: a staff row left on the appointment holds
 * nobody's time.
 */

import { buildConsultantOccupancyWhere } from "@/utils/scheduling-engine/occupancyPolicy";
import { matchesWhere, type Row, type Where } from "../fixtures/mem-db";

const PROFILE = "collaborator-profile";
const USER = "collaborator-user";
const NOW = new Date("2026-11-16T10:00:00Z");

/** A published webinar's appointment carrying a live staff row for the user. */
const cohostedWebinar = (collaboratorStatus: string): Row => ({
  webinar: {
    status: "SCHEDULED",
    webinarPlan: {
      consultantProfileId: "host-profile",
      collaborators: [
        { consultantProfileId: PROFILE, status: collaboratorStatus },
      ],
    },
  },
  participants: [
    { userId: USER, role: "COLLABORATOR", status: "CONFIRMED", payment: null },
  ],
  occurrences: [
    { deletedAt: null, hostCancelledAt: null, completionStatus: "SCHEDULED" },
  ],
  payment: [],
});

const busy = (appointment: Row) =>
  matchesWhere(
    appointment,
    buildConsultantOccupancyWhere(PROFILE, USER, NOW) as Where,
  );

describe("a staff participant row holds no time", () => {
  it("frees a removed collaborator whose staff row is still live", () => {
    expect(busy(cohostedWebinar("REMOVED"))).toBe(false);
  });

  it("keeps an accepted collaborator busy through the team", () => {
    expect(busy(cohostedWebinar("ACCEPTED"))).toBe(true);
  });

  it("still holds the time of a learner seat", () => {
    const seated = cohostedWebinar("REMOVED");
    seated.participants = [
      { userId: USER, role: "CONSULTEE", status: "CONFIRMED", payment: null },
    ];
    expect(busy(seated)).toBe(true);
  });
});
