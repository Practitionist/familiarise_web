/**
 * @jest-environment node
 */

/** #1834 — the issue door's session key: the right booking, and one amount only. */

const db = {
  occurrenceAppt: "apt-1",
  occurrenceStart: new Date("2026-10-08T10:00:00Z"),
  prior: null as {
    paymentId: string;
    amountPaise: number;
    status: string;
  } | null,
  refunds: [] as { amountPaise: number; status: string }[],
  liveSeat: true,
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: async () => ({
        appointmentId: "apt-1",
        userId: "u-1",
        amount: 80_000,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        refunds: db.refunds,
        disputes: [],
      }),
    },
    appointmentOccurrence: {
      findUnique: async () => ({
        appointmentId: db.occurrenceAppt,
        startsAt: db.occurrenceStart,
      }),
    },
    appointmentParticipant: {
      findFirst: async () =>
        db.liveSeat ? { createdAt: new Date("2026-09-20T00:00:00Z") } : null,
    },
    refund: { findUnique: async () => db.prior },
  },
}));

import { assertSessionRefundable } from "@/lib/backoffice/refund-doors";

const ask = (amountPaise?: number) =>
  assertSessionRefundable({
    paymentId: "pay-1",
    occurrenceId: "occ-1",
    dedupeKey: "occ:occ-1:pay:pay-1",
    amountPaise,
  });

it("refuses a foreign or pre-seat session, and a changed full refund, but replays the first", async () => {
  db.occurrenceAppt = "apt-other";
  await expect(ask(10_000)).rejects.toMatchObject({
    code: "SESSION_NOT_ON_PAYMENT",
  });

  db.occurrenceAppt = "apt-1";
  // Joined 1 Oct (the later of seat and payment): a 24 Sep session was never held.
  db.occurrenceStart = new Date("2026-09-24T10:00:00Z");
  await expect(ask(10_000)).rejects.toMatchObject({
    code: "SESSION_BEFORE_SEAT",
  });
  db.occurrenceStart = new Date("2026-10-08T10:00:00Z");
  // The session key spent on another payment never replays here.
  db.prior = {
    paymentId: "pay-other",
    amountPaise: 10_000,
    status: "SUCCEEDED",
  };
  await expect(ask(10_000)).rejects.toMatchObject({
    code: "IDEMPOTENCY_KEY_REUSED",
  });
  const partial = {
    paymentId: "pay-1",
    amountPaise: 10_000,
    status: "SUCCEEDED",
  };
  db.prior = partial;
  db.refunds = [partial];
  await expect(ask(10_000)).resolves.toBeUndefined();
  // A full request now resolves to 80 000, not the first refund's 10 000.
  await expect(ask()).rejects.toMatchObject({
    code: "SESSION_ALREADY_REFUNDED",
  });

  const full = { paymentId: "pay-1", amountPaise: 80_000, status: "SUCCEEDED" };
  db.prior = full;
  db.refunds = [full];
  await expect(ask()).resolves.toBeUndefined();
});

it("replays an identical retry after the session refund ended the seat", async () => {
  const full = { paymentId: "pay-1", amountPaise: 80_000, status: "SUCCEEDED" };
  db.prior = full;
  db.refunds = [full];
  db.liveSeat = false;

  await expect(ask()).resolves.toBeUndefined();
  await expect(ask(80_000)).resolves.toBeUndefined();
  await expect(ask(10_000)).rejects.toMatchObject({
    code: "SESSION_ALREADY_REFUNDED",
  });
});
