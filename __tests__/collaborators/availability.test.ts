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
        // Each commitment clause names a consultantProfileId via one of six
        // shapes (consultation/subscription/webinar/class owner, plus webinar/
        // class collaborator). Extract from ALL of them so a regression in any
        // shape — notably the collaborator predicates — is actually exercised.
        type Owned = { consultantProfileId?: string };
        type Collab = {
          collaborators?: { some?: { consultantProfileId?: string } };
        };
        type Clause = {
          consultation?: { consultationPlan?: Owned };
          subscription?: { subscriptionPlan?: Owned };
          webinar?: { webinarPlan?: Owned & Collab };
          class?: { classPlan?: Owned & Collab };
        };
        const profileIdOf = (c: Clause): string | undefined =>
          c.consultation?.consultationPlan?.consultantProfileId ??
          c.subscription?.subscriptionPlan?.consultantProfileId ??
          c.webinar?.webinarPlan?.consultantProfileId ??
          c.webinar?.webinarPlan?.collaborators?.some?.consultantProfileId ??
          c.class?.classPlan?.consultantProfileId ??
          c.class?.classPlan?.collaborators?.some?.consultantProfileId;
        const orClauses: Clause[] = where.appointment.OR;
        const clash = orClauses.some((clause) =>
          opts.conflictForProfileIds?.includes(profileIdOf(clause) ?? ""),
        );
        return Promise.resolve(clash ? { id: "conflict-slot" } : null);
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
    // #1319 — the guard now excludes a set (a class allocation carries every
    // session of the event), so a single exclusion is a one-element notIn.
    expect(where.appointmentId).toEqual({ notIn: ["appt-self"] });
    expect(where.isTentative).toBe(false);
  });
});
