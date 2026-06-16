/**
 * @jest-environment node
 */

/**
 * AE-2 (#784) — co-hosts aren't slot participants, so nothing else catches a
 * co-host being double-booked when an event is scheduled. These pin the guard:
 * no-op without collaborators, throw when an accepted co-host overlaps.
 */

import {
  assertCollaboratorsAvailable,
  CollaboratorUnavailableError,
} from "@/lib/collaborators/availability";

function makeDb(opts: {
  collaborators: Array<{ name: string | null; consultantProfileId: string }>;
  conflictForProfileIds?: string[];
}) {
  return {
    collaborator: {
      findMany: jest.fn().mockResolvedValue(
        opts.collaborators.map((c) => ({
          consultantProfileId: c.consultantProfileId,
          consultantProfile: { user: { name: c.name } },
        })),
      ),
    },
    slotOfAppointment: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        // The per-collaborator profile id lives in the appointment OR filter;
        // resolve a conflict if that collaborator is in the conflict set.
        const profileId =
          where.appointment.OR[0].consultation.consultationPlan
            .consultantProfileId;
        return Promise.resolve(
          opts.conflictForProfileIds?.includes(profileId)
            ? { id: "conflict-slot" }
            : null,
        );
      }),
    },
  };
}

const base = {
  planType: "WEBINAR" as const,
  planId: "plan-1",
  startsAt: new Date("2026-07-01T10:00:00.000Z"),
  endsAt: new Date("2026-07-01T11:00:00.000Z"),
};

describe("assertCollaboratorsAvailable", () => {
  it("no-ops when the plan has no accepted collaborators", async () => {
    const db = makeDb({ collaborators: [] });
    await expect(
      assertCollaboratorsAvailable(db as never, base),
    ).resolves.toBeUndefined();
    expect(db.slotOfAppointment.findFirst).not.toHaveBeenCalled();
  });

  it("resolves when accepted co-hosts have no overlapping commitment", async () => {
    const db = makeDb({
      collaborators: [{ name: "Alice", consultantProfileId: "p1" }],
    });
    await expect(
      assertCollaboratorsAvailable(db as never, base),
    ).resolves.toBeUndefined();
  });

  it("throws naming the clashing co-host(s)", async () => {
    const db = makeDb({
      collaborators: [
        { name: "Alice", consultantProfileId: "p1" },
        { name: "Bob", consultantProfileId: "p2" },
      ],
      conflictForProfileIds: ["p2"],
    });
    await expect(
      assertCollaboratorsAvailable(db as never, base),
    ).rejects.toBeInstanceOf(CollaboratorUnavailableError);
    await expect(
      assertCollaboratorsAvailable(db as never, base),
    ).rejects.toThrow("Bob");
  });

  it("excludes the event's own appointment from the conflict scan", async () => {
    const db = makeDb({
      collaborators: [{ name: "Alice", consultantProfileId: "p1" }],
    });
    await assertCollaboratorsAvailable(db as never, {
      ...base,
      excludeAppointmentId: "appt-self",
    });
    const where = db.slotOfAppointment.findFirst.mock.calls[0][0].where;
    expect(where.appointmentId).toEqual({ not: "appt-self" });
    expect(where.isTentative).toBe(false);
  });
});
