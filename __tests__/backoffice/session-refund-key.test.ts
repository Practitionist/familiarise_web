/**
 * @jest-environment node
 */

/** #1834 — the issue door's session key: the right booking, and one amount only. */

const db = {
  occurrenceAppt: "apt-1",
  prior: null as { amountPaise: number; status: string } | null,
  refunds: [] as { amountPaise: number; status: string }[],
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: async () => ({
        appointmentId: "apt-1",
        userId: "u-1",
        amount: 80_000,
        refunds: db.refunds,
        disputes: [],
      }),
    },
    appointmentOccurrence: {
      findUnique: async () => ({ appointmentId: db.occurrenceAppt }),
    },
    appointmentParticipant: { findFirst: async () => ({ id: "seat-1" }) },
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

it("refuses a foreign session, and a changed full refund, but replays the first", async () => {
  db.occurrenceAppt = "apt-other";
  await expect(ask(10_000)).rejects.toMatchObject({
    code: "SESSION_NOT_ON_PAYMENT",
  });

  db.occurrenceAppt = "apt-1";
  const partial = { amountPaise: 10_000, status: "SUCCEEDED" };
  db.prior = partial;
  db.refunds = [partial];
  await expect(ask(10_000)).resolves.toBeUndefined();
  // A full request now resolves to 80 000, not the first refund's 10 000.
  await expect(ask()).rejects.toMatchObject({
    code: "SESSION_ALREADY_REFUNDED",
  });

  const full = { amountPaise: 80_000, status: "SUCCEEDED" };
  db.prior = full;
  db.refunds = [full];
  await expect(ask()).resolves.toBeUndefined();
});
