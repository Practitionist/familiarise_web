/**
 * A class re-plan never turns a mid-checkout (HELD) seat into a paid one: the
 * Payment pins the one class wrapper, and the re-seat skips a live row. It
 * carries learner seats only: a staff row never comes back as a learner.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(async () => undefined),
}));

import { deleteExistingAppointments } from "@/lib/booking/allocation/commit/release-tentative";
import { createAppointments } from "@/lib/booking/allocation/commit/create-appointments";
import {
  collectEventParticipantIds,
  reconnectEnrolledUsers,
} from "@/lib/booking/allocation/commit/reconnect-enrolled";
import { paidParticipant } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import {
  matchesWhere,
  memTable,
  type Row,
  type Where,
} from "../fixtures/mem-db";

const HOST = "host-user";
const LEARNER = "held-learner";
const COLLABORATOR = "collaborator-user";
const DAY_MS = 86_400_000;
const at = (days: number, minutes = 0) =>
  new Date(Date.now() + days * DAY_MS + minutes * 60_000);
const session = (
  id: string,
  ordinal: number,
  days: number,
  status: string,
) => ({
  id,
  appointmentId: "apt-1",
  ordinal,
  startsAt: at(days),
  endsAt: at(days, 60),
  isTentative: false,
  completionStatus: status,
  deletedAt: null,
});

const HELD_SEAT_PAYMENT: Row = {
  id: "pay-held",
  appointmentId: "apt-1",
  paymentStatus: "PENDING",
  description: null,
  refundOwedKey: null,
  refunds: [],
};
const seat = (userId: string, role: string, extra: Row = {}): Row => ({
  appointmentId: "apt-1",
  userId,
  role,
  status: "CONFIRMED",
  paymentId: null,
  ...extra,
});

function classWorld(
  sessions: Row[],
  opts: { payments?: Row[]; seats?: Row[] } = {},
) {
  const appointments: Row[] = [
    { id: "apt-1", classId: "class-1", cancellationPolicyId: null },
  ];
  const occurrences: Row[] = [...sessions];
  const payments: Row[] = opts.payments ?? [HELD_SEAT_PAYMENT];
  const participants = memTable(
    opts.seats ?? [
      seat(HOST, "CONSULTANT"),
      seat(LEARNER, "CONSULTEE", { status: "HELD", paymentId: "pay-held" }),
    ],
    "seat",
    { unique: [["appointmentId", "userId"]] },
  );
  const paymentsOf = (id: unknown) =>
    payments.filter((p) => p.appointmentId === id);
  const removeWhere = (rows: Row[], keep: (r: Row) => boolean) => {
    const kept = rows.filter(keep);
    const count = rows.length - kept.length;
    rows.splice(0, rows.length, ...kept);
    return count;
  };

  const tx = {
    consultantProfile: { findFirst: async () => ({ id: "cp-1" }) },
    appointmentParticipant: participants,
    appointmentOccurrence: {
      deleteMany: async ({ where }: { where: Where }) => ({
        count: removeWhere(occurrences, (o) => !matchesWhere(o, where)),
      }),
      aggregate: async ({ where }: { where: Where }) => {
        const ordinals = occurrences
          .filter((o) => matchesWhere(o, where))
          .map((o) => Number(o.ordinal));
        return {
          _max: { ordinal: ordinals.length ? Math.max(...ordinals) : null },
        };
      },
    },
    appointment: {
      findMany: async (args: {
        where: Where;
        include: { participants: { where: Where } };
      }) =>
        appointments
          .filter((a) => matchesWhere(a, args.where))
          .map((a) => ({
            ...a,
            participants: participants.rows
              .filter(
                (s) =>
                  s.appointmentId === a.id &&
                  matchesWhere(s, args.include.participants.where),
              )
              .map((s) => ({ userId: s.userId })),
            occurrences: occurrences
              .filter((o) => o.appointmentId === a.id)
              .map((o) => ({
                ...o,
                meeting: null,
                _count: { incidentRemedies: 0 },
              })),
            _count: { payment: paymentsOf(a.id).length },
          })),
      findFirst: async ({ where }: { where: Where }) => {
        const hit = appointments.find((a) => matchesWhere(a, where));
        return hit ? { ...hit } : null;
      },
      // Payment.appointment is onDelete: Restrict, so Postgres refuses the delete.
      deleteMany: async ({ where }: { where: Where }) => {
        const doomed = appointments.filter((a) =>
          matchesWhere({ ...a, payment: paymentsOf(a.id) }, where),
        );
        if (doomed.some((a) => paymentsOf(a.id).length > 0)) {
          throw new Error("Foreign key violation: Payment_appointmentId_fkey");
        }
        const ids = new Set(doomed.map((a) => a.id));
        removeWhere(participants.rows, (s) => !ids.has(s.appointmentId));
        removeWhere(occurrences, (o) => !ids.has(o.appointmentId));
        return { count: removeWhere(appointments, (a) => !ids.has(a.id)) };
      },
      create: async (args: {
        data: Row & { occurrences: { create: Row[] } };
      }) => {
        const { occurrences: written, ...wrapper } = args.data;
        const id = `apt-${appointments.length + 2}`;
        appointments.push({ id, ...wrapper });
        const rows = written.create.map((row, i) => ({
          id: `occ-new-${i + 1}`,
          appointmentId: id,
          completionStatus: "SCHEDULED",
          deletedAt: null,
          ...row,
        }));
        occurrences.push(...rows);
        return { id, ...wrapper, occurrences: rows };
      },
      update: async (args: {
        where: { id: string };
        data: { occurrences: { create: Row[] } };
      }) => {
        for (const [i, row] of args.data.occurrences.create.entries()) {
          occurrences.push({
            id: `occ-new-${i + 1}`,
            appointmentId: args.where.id,
            completionStatus: "SCHEDULED",
            deletedAt: null,
            ...row,
          });
        }
        const wrapper = appointments.find((a) => a.id === args.where.id);
        return {
          ...wrapper,
          occurrences: occurrences.filter(
            (o) => o.appointmentId === args.where.id,
          ),
        };
      },
    },
  };

  return { tx, appointments, occurrences, payments, participants };
}

async function replan(
  world: ReturnType<typeof classWorld>,
  inProgress: boolean,
) {
  const tx = world.tx as unknown as Tx;
  const freed = await deleteExistingAppointments(
    tx,
    "class",
    "class-1",
    false,
    inProgress,
  );
  const { appointments } = await createAppointments(
    tx,
    "class",
    "class-1",
    [at(9), at(9, 30)],
    HOST,
    undefined,
    undefined,
    null,
    freed.reusableAppointmentId,
    undefined,
    freed.freedOrdinals,
    { isReschedule: false, freedWindows: freed.freedWindows },
  );
  await reconnectEnrolledUsers(
    tx,
    appointments,
    freed.enrolledUserIds,
    HOST,
    null,
  );
  return freed;
}

function expectSeatStillHeld(world: ReturnType<typeof classWorld>) {
  expect(world.appointments.map((a) => a.id)).toEqual(["apt-1"]);
  expect(world.payments).toHaveLength(1);
  const seats = world.participants.rows.filter((s) => s.userId === LEARNER);
  expect(seats).toEqual([
    expect.objectContaining({ status: "HELD", paymentId: "pay-held" }),
  ]);
  // The re-seat did try to confirm the learner; the existing row absorbed it.
  expect(world.participants.createMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: [expect.objectContaining({ userId: LEARNER, status: "CONFIRMED" })],
      skipDuplicates: true,
    }),
  );
  const gate: Where = paidParticipant(LEARNER);
  const seat = { ...seats[0], payment: world.payments[0] };
  expect(matchesWhere(seat, gate)).toBe(false);
}

describe("class reallocation keeps a HELD seat held", () => {
  it("in-progress re-plan re-seats around a pending checkout without confirming it", async () => {
    const world = classWorld([
      session("occ-past", 1, -7, "COMPLETED"),
      session("occ-future", 2, 7, "SCHEDULED"),
    ]);
    const freed = await replan(world, true);
    expect(freed.enrolledUserIds).toContain(LEARNER);
    expect(world.occurrences.map((o) => o.id)).toEqual([
      "occ-past",
      "occ-new-1",
    ]);
    expect(world.occurrences[1]).toMatchObject({ ordinal: 2 });
    expectSeatStillHeld(world);
  });

  it("full re-plan keeps the payment-bearing wrapper and strips only its sessions", async () => {
    const world = classWorld([
      session("occ-a", 1, 7, "SCHEDULED"),
      session("occ-b", 2, 8, "SCHEDULED"),
    ]);
    const freed = await replan(world, false);
    expect(freed.enrolledUserIds).toContain(LEARNER);
    expect(world.occurrences.map((o) => o.id)).toEqual(["occ-new-1"]);
    expectSeatStillHeld(world);
  });
});

describe("a re-plan carries learner seats only", () => {
  const staffedSeats = () => [
    seat(HOST, "CONSULTANT"),
    seat(LEARNER, "CONSULTEE"),
    seat(COLLABORATOR, "COLLABORATOR"),
  ];
  const learnerSeats = (world: ReturnType<typeof classWorld>) =>
    world.participants.rows.filter((s) => s.role === "CONSULTEE");

  it("re-seats the learner and never the collaborator when the payment-free wrapper is replaced", async () => {
    const world = classWorld(
      [
        session("occ-a", 1, 7, "SCHEDULED"),
        session("occ-b", 2, 8, "SCHEDULED"),
      ],
      { payments: [], seats: staffedSeats() },
    );
    expect(learnerSeats(world)).toHaveLength(1);

    await replan(world, false);

    // The old wrapper went with its rows; the new one seats the learner again.
    expect(world.appointments.map((a) => a.id)).toEqual(["apt-2"]);
    expect(
      world.participants.rows.filter((s) => s.userId === COLLABORATOR),
    ).toEqual([]);
    expect(learnerSeats(world)).toEqual([
      expect.objectContaining({
        appointmentId: "apt-2",
        userId: LEARNER,
        status: "CONFIRMED",
      }),
    ]);
  });

  it.each([
    ["an in-progress re-plan", false, true],
    ["a reschedule's released sessions", true, false],
  ])(
    "collects only learner seats from %s",
    async (_, onlyTentative, inProgress) => {
      const world = classWorld(
        [
          {
            ...session("occ-a", 1, 7, "RESCHEDULED"),
            isTentative: true,
          },
        ],
        { payments: [], seats: staffedSeats() },
      );
      const freed = await deleteExistingAppointments(
        world.tx as unknown as Tx,
        "class",
        "class-1",
        onlyTentative,
        inProgress,
      );
      expect(freed.enrolledUserIds).toEqual([LEARNER]);
    },
  );

  it("reads only learner seats off the surviving sessions for a top-up", async () => {
    const appointment = {
      classId: "class-1",
      occurrences: [{ isTentative: false, deletedAt: null }],
    };
    const participants = memTable(
      staffedSeats().map((row) => ({ ...row, appointment })),
    );
    const ids = await collectEventParticipantIds(
      { appointmentParticipant: participants } as unknown as Tx,
      "class",
      "class-1",
    );
    expect(ids).toEqual([LEARNER]);
  });
});
