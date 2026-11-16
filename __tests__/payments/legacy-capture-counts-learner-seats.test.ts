/**
 * @jest-environment node
 */

/**
 * A capture that arrives with no appointment replays the capacity gate against
 * learner seats only: the host's row and a staff row never fill the room.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { createAppointmentFromWebhook } from "@/lib/payments/webhooks/legacy-appointment-creation";
import type { Tx } from "@/lib/prisma";
import {
  matchesWhere,
  memTable,
  type Row,
  type Where,
} from "../fixtures/mem-db";

const BUYER = "buyer-user";
const seat = (userId: string, role: string): Row => ({
  appointmentId: "apt-1",
  userId,
  role,
  status: "CONFIRMED",
  paymentId: null,
  payment: null,
});

/** A two-seat event holding one learner, the host's row and a staff row. */
function eventWorld() {
  const participants = memTable(
    [
      seat("host-user", "CONSULTANT"),
      seat("learner-user", "CONSULTEE"),
      seat("collaborator-user", "COLLABORATOR"),
    ],
    "seat",
    { unique: [["appointmentId", "userId"]] },
  );
  const plan = {
    maxParticipants: 2,
    consultantProfile: { userId: "host-user" },
  };
  const event = (args: {
    include: { appointment: { include: { participants: { where: Where } } } };
  }) => ({
    id: "event-1",
    maxParticipants: null,
    webinarPlan: plan,
    classPlan: plan,
    appointment: {
      id: "apt-1",
      occurrences: [{ id: "occ-1" }],
      participants: participants.rows.filter((row) =>
        matchesWhere(row, args.include.appointment.include.participants.where),
      ),
    },
  });
  const tx = {
    webinar: {
      findUnique: async (args: Parameters<typeof event>[0]) => event(args),
    },
    class: {
      findUnique: async (args: Parameters<typeof event>[0]) => event(args),
    },
    appointmentParticipant: participants,
    appointment: {
      findUnique: async () => ({ id: "apt-1", occurrences: [{ id: "occ-1" }] }),
    },
    payment: { updateMany: async () => ({ count: 1 }) },
  };
  return { tx, participants };
}

const payment = {
  id: "pay-1",
  organizationId: null,
  paymentMethod: null,
  originalAmount: 0,
  user: { id: BUYER, consulteeProfile: { id: "consultee-profile-1" } },
} as unknown as Parameters<typeof createAppointmentFromWebhook>[2];

describe("a recovery capture counts learner seats only", () => {
  it.each(["WEBINAR", "CLASS"])(
    "seats the buyer of a %s whose last place a staff row seemed to fill",
    async (appointmentType) => {
      const world = eventWorld();
      const appointment = await createAppointmentFromWebhook(
        world.tx as unknown as Tx,
        { appointmentType, eventId: "event-1" },
        payment,
      );
      expect(appointment).toMatchObject({ id: "apt-1" });
      expect(
        world.participants.rows.filter((row) => row.userId === BUYER),
      ).toEqual([
        expect.objectContaining({ role: "CONSULTEE", status: "HELD" }),
      ]);
    },
  );
});
