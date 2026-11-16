/**
 * @jest-environment node
 */

/**
 * The buyer's trial pick, written in one transaction: a free trial confirms
 * at once (a confirmed session, CONFIRMED seats, SCHEDULED through the CAS);
 * a paid trial holds the time (a tentative session, HELD seats,
 * AWAITING_PAYMENT with the pay window closing 15 minutes before the start).
 * A refused time writes nothing.
 */

const refusal = { value: null as null | "OUTSIDE_AVAILABILITY" | "SLOT_TAKEN" };
jest.mock("../../lib/trials/slot-check", () => {
  const actual = jest.requireActual("../../lib/trials/slot-check");
  return {
    ...actual,
    trialWindowRefusal: jest.fn(async () => refusal.value),
  };
});
const recordParticipants = jest.fn(async () => undefined);
jest.mock("../../lib/booking/participants", () => ({
  recordParticipants: (...a: unknown[]) => recordParticipants(...(a as [])),
}));

import { payWindowEnd } from "../../lib/payments/operations/approval-payment";
import {
  bookTrialInTx,
  TrialTimeRefusedError,
} from "../../lib/trials/book-trial";
import type { Tx } from "../../lib/prisma";

const NOW = new Date("2026-11-10T08:00:00.000Z");
const START = new Date("2026-11-12T10:00:00.000Z");
const END = new Date("2026-11-12T10:30:00.000Z");

function fakeTx() {
  const tx = {
    appointment: { create: jest.fn(async () => ({ id: "apt-1" })) },
    trial: {
      // The pair holds no blocking trial.
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: { status: string } }) => ({
        id: "trial-1",
        status: data.status,
        appointmentId: "apt-1",
      })),
      updateMany: jest.fn(),
    },
    bookingStatusHistory: { create: jest.fn(async () => ({})) },
  };
  return { tx };
}

const createdData = (tx: ReturnType<typeof fakeTx>["tx"]) =>
  (tx.trial.create.mock.calls[0] as unknown as [{ data: object }])[0].data;

const args = (paid: boolean) => ({
  consulteeProfileId: "cee-1",
  consultantProfileId: "cp-1",
  subscriptionPlanId: "plan-1",
  notes: null,
  organizationId: null,
  consulteeUserId: "u-buyer",
  consultantUserId: "u-expert",
  paid,
  agreedPricePaise: paid ? 49_900 : 0,
  startsAt: START,
  endsAt: END,
  now: NOW,
});

beforeEach(() => {
  jest.clearAllMocks();
  refusal.value = null;
});

it("a free pick writes a confirmed session and moves the trial straight to SCHEDULED", async () => {
  const { tx } = fakeTx();
  const out = await bookTrialInTx(tx as unknown as Tx, args(false));

  expect(tx.appointment.create).toHaveBeenCalledWith({
    data: {
      appointmentType: "TRIAL",
      occurrences: {
        create: expect.objectContaining({
          ordinal: 1,
          startsAt: START,
          endsAt: END,
          isTentative: false,
          consultantProfileId: "cp-1",
        }),
      },
    },
    select: { id: true },
  });
  expect(recordParticipants).toHaveBeenCalledWith(
    tx,
    "apt-1",
    expect.any(Array),
    expect.objectContaining({ status: "CONFIRMED" }),
  );
  // Born in its final state: no PENDING row and no transition.
  expect(createdData(tx)).toMatchObject({ status: "SCHEDULED" });
  expect(createdData(tx)).not.toHaveProperty("paymentDueAt");
  expect(tx.trial.updateMany).not.toHaveBeenCalled();
  expect(out).toEqual(
    expect.objectContaining({ status: "SCHEDULED", appointmentId: "apt-1" }),
  );
  // One creation row, in this transaction.
  expect(tx.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
  expect(tx.bookingStatusHistory.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      fromStatus: "CREATED",
      toStatus: "SCHEDULED",
    }),
  });
});

it("a paid pick holds the time tentatively, AWAITING_PAYMENT, with the pay window pinned to the start", async () => {
  const { tx } = fakeTx();
  await bookTrialInTx(tx as unknown as Tx, args(true));

  expect(tx.appointment.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        occurrences: {
          create: expect.objectContaining({ isTentative: true }),
        },
      }),
    }),
  );
  expect(recordParticipants).toHaveBeenCalledWith(
    tx,
    "apt-1",
    expect.any(Array),
    expect.objectContaining({ status: "HELD" }),
  );
  const dueAt = payWindowEnd(NOW, START);
  // 24 h from now ends before the session, so the window is the full 24 h.
  expect(dueAt.toISOString()).toBe("2026-11-11T08:00:00.000Z");
  expect(createdData(tx)).toMatchObject({
    status: "AWAITING_PAYMENT",
    paymentDueAt: dueAt,
  });
});

it("a pick close to the start closes the pay window 15 minutes before it", () => {
  const soon = new Date(NOW.getTime() + 3 * 3_600_000);
  expect(payWindowEnd(NOW, soon).toISOString()).toBe(
    new Date(soon.getTime() - 15 * 60_000).toISOString(),
  );
});

it.each(["OUTSIDE_AVAILABILITY", "SLOT_TAKEN"] as const)(
  "a %s time throws the typed refusal and writes nothing",
  async (code) => {
    refusal.value = code;
    const { tx } = fakeTx();
    const err = await bookTrialInTx(tx as unknown as Tx, args(false)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrialTimeRefusedError);
    expect((err as TrialTimeRefusedError).code).toBe(code);
    expect((err as TrialTimeRefusedError).httpStatus).toBe(
      code === "SLOT_TAKEN" ? 409 : 400,
    );
    expect(tx.appointment.create).not.toHaveBeenCalled();
    expect(tx.trial.create).not.toHaveBeenCalled();
  },
);
