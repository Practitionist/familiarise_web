/**
 * @jest-environment node
 */

// Invariant: shrinking availability never refuses; the bookings it leaves
// outside the new hours are listed before the save, and only the new ones,
// each with its learner and plan from one batched read.

jest.mock("../../lib/profiles/profile-completion", () => ({
  recomputeProfileCompletion: jest.fn(),
}));

import {
  findUncoveredUpcoming,
  previewNewlyUncovered,
} from "@/lib/scheduling/uncovered-upcoming";
import { availabilitySavePreviewSchema } from "@/schemas/availability-preview";

const NOW = new Date("2030-03-01T00:00:00.000Z");
const at = (iso: string) => new Date(`2030-03-${iso}:00.000Z`);
const session = (id: string, start: string, isTentative = false) => ({
  appointmentId: id,
  startsAt: at(start),
  endsAt: new Date(at(start).getTime() + 30 * 60_000),
  isTentative,
});
const window = (start: string, end: string) => ({
  startsAt: at(start),
  endsAt: at(end),
});

function dbWith(storedCustom: { startsAt: Date; endsAt: Date }[]) {
  return {
    appointmentOccurrence: {
      findMany: jest.fn(async () => [
        session("inside", "05T10:00"),
        session("moved-out", "06T10:00", true),
        session("already-out", "07T10:00"),
      ]),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({
        scheduleType: "CUSTOM",
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: storedCustom,
      })),
    },
    appointment: {
      findMany: jest.fn(async () => [
        {
          id: "moved-out",
          appointmentType: "CONSULTATION",
          consultation: {
            consultationPlan: { title: "Career chat" },
            requestedBy: { user: { name: "Priya Nair" } },
          },
          subscription: null,
          webinar: null,
          class: null,
          trial: null,
        },
      ]),
    },
    availabilityWindowWeekly: {},
    availabilityWindowCustom: {},
  };
}

describe("findUncoveredUpcoming", () => {
  it("lists each uncovered booking once, soonest first, with its hold state", async () => {
    const db = dbWith([]);
    const result = await findUncoveredUpcoming(
      db as never,
      "cp-1",
      {
        scheduleType: "CUSTOM",
        weeklyRows: [],
        customRows: [window("05T09:00", "05T12:00")],
      },
      NOW,
    );
    expect(result.count).toBe(2);
    expect(result.awaitingConfirmation).toBe(1);
    expect(result.sessions.map((s) => [s.appointmentId, s.held])).toEqual([
      ["moved-out", true],
      ["already-out", false],
    ]);
  });
});

describe("previewNewlyUncovered", () => {
  const stored = [
    window("05T09:00", "05T12:00"),
    window("06T09:00", "06T12:00"),
  ];

  it("names only the bookings the proposed hours newly leave outside", async () => {
    const preview = await previewNewlyUncovered(
      dbWith(stored) as never,
      "cp-1",
      {
        scheduleType: "CUSTOM",
        weeklyRows: [],
        customRows: [window("05T09:00", "05T12:00")],
      },
      NOW,
    );
    expect(preview.sessions.map((s) => s.appointmentId)).toEqual(["moved-out"]);
    expect(preview.customDatesRemoved).toBe(0);
  });

  it("names each booking's learner and plan in one read of the newly uncovered bookings", async () => {
    const db = dbWith(stored);
    const preview = await previewNewlyUncovered(
      db as never,
      "cp-1",
      {
        scheduleType: "CUSTOM",
        weeklyRows: [],
        customRows: [window("05T09:00", "05T12:00")],
      },
      NOW,
    );
    expect(db.appointment.findMany).toHaveBeenCalledTimes(1);
    expect(db.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["moved-out"] } } }),
    );
    expect(preview.sessions).toEqual([
      expect.objectContaining({
        appointmentId: "moved-out",
        learnerName: "Priya Nair",
        planTitle: "Career chat",
      }),
    ]);
    // What the route sends is what the settings form parses.
    const wire = JSON.parse(JSON.stringify(preview));
    expect(availabilitySavePreviewSchema.parse(wire).sessions[0]).toEqual(
      expect.objectContaining({ learnerName: "Priya Nair" }),
    );
  });

  it("reads no booking when nothing is newly uncovered", async () => {
    const db = dbWith(stored);
    await previewNewlyUncovered(
      db as never,
      "cp-1",
      { scheduleType: "CUSTOM", weeklyRows: [], customRows: stored },
      NOW,
    );
    expect(db.appointment.findMany).not.toHaveBeenCalled();
  });

  it("counts the upcoming custom dates a weekly save removes", async () => {
    const preview = await previewNewlyUncovered(
      dbWith(stored) as never,
      "cp-1",
      { scheduleType: "WEEKLY", weeklyRows: [], customRows: [] },
      NOW,
    );
    expect(preview.customDatesRemoved).toBe(2);
  });
});
