/**
 * @jest-environment node
 */

// Invariant: removing a collaborator's standing cancels only live seats; a REFUNDED seat stays terminal.

import { removeCollaboratorStanding } from "@/lib/collaborators/standing";
import type { Tx } from "@/lib/prisma";

type Seat = { userId: string; role: string; status: string };

it("cancels the live collaborator seat and leaves the REFUNDED one unchanged", async () => {
  const seats: Seat[] = [
    { userId: "u-1", role: "COLLABORATOR", status: "CONFIRMED" },
    { userId: "u-1", role: "COLLABORATOR", status: "REFUNDED" },
  ];
  const updateMany = jest.fn(
    async (args: {
      where: { AND: [unknown, { status: { in: string[] } }] };
      data: { status: string };
    }) => {
      const allowed = args.where.AND[1].status.in;
      const hit = seats.filter((s) => allowed.includes(s.status));
      hit.forEach((s) => (s.status = args.data.status));
      return { count: hit.length };
    },
  );
  const tx = {
    user: {
      findUnique: async () => ({ name: "Cara", consultantProfileId: "cp-1" }),
    },
    collaborator: {
      updateManyAndReturn: async () => [
        {
          id: "col-1",
          collaboratorType: "WEBINAR",
          webinarPlanId: "wp-1",
          classPlanId: null,
          role: "CO_HOST",
          revenueShareBps: 1000,
          webinarPlan: { title: "W", consultantProfile: { userId: "host" } },
          classPlan: null,
        },
      ],
    },
    appointmentParticipant: { updateMany },
  } as unknown as Tx;

  await removeCollaboratorStanding(tx, "u-1");

  expect(seats.map((s) => s.status)).toEqual(["CANCELLED", "REFUNDED"]);
});
