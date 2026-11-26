/**
 * @jest-environment node
 */

/**
 * A captured payment's bells (payment success, then "you're booked" to the
 * booker and the host) are staged on the confirmation transaction only.
 */

const mockGlobal = jest.fn((): never => {
  throw new Error("global client used");
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: () => mockGlobal() },
    notificationOutbox: { upsert: () => mockGlobal() },
    appointment: { findUnique: () => mockGlobal() },
    $transaction: () => mockGlobal(),
  },
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => {
    throw new Error("Novu called inside the transaction");
  },
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import type { Tx } from "@/lib/prisma";
import {
  loadAppointmentForEmails,
  stagePaymentSuccessBells,
  type PaymentWithUser,
} from "@/lib/payments/webhooks/staged-emails";

// The row shape loadAppointmentForEmails' include returns for a consultation.
const APPOINTMENT_ROW = {
  id: "appt-1",
  organizationId: null,
  organization: null,
  occurrences: [
    {
      startsAt: new Date("2026-12-01T10:00:00Z"),
      endsAt: new Date("2026-12-01T11:00:00Z"),
    },
  ],
  consultation: {
    consultationPlan: {
      title: "Intro call",
      consultantProfile: { user: { id: "host-1", name: "Arjun" } },
    },
  },
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
};

const PAYMENT = {
  id: "pay-1",
  userId: "booker-1",
  amount: 150_000,
  currency: "INR",
  user: { id: "booker-1", name: "Riya", consulteeProfile: null },
} as unknown as PaymentWithUser;

function confirmationTx() {
  const upserts: Array<{
    create: { workflowId: string; recipients: string[] };
  }> = [];
  const tx = {
    appointment: { findUnique: async () => APPOINTMENT_ROW },
    user: {
      findMany: jest.fn(async () => [
        {
          id: "booker-1",
          timezone: "Asia/Kolkata",
          erasedAt: null,
          notificationPreferences: null,
        },
        {
          id: "host-1",
          timezone: "Asia/Kolkata",
          erasedAt: null,
          notificationPreferences: null,
        },
      ]),
    },
    notificationOutbox: {
      upsert: jest.fn(
        async (q: { create: { workflowId: string; recipients: string[] } }) => {
          upserts.push(q);
          return { id: `nx-${upserts.length}`, status: "PENDING" };
        },
      ),
    },
    membership: {},
  } as unknown as Tx;
  return { tx, upserts };
}

describe("stagePaymentSuccessBells", () => {
  it("stages the payment-success and booked bells through the transaction", async () => {
    const { tx, upserts } = confirmationTx();
    const appointment = await loadAppointmentForEmails(tx, "appt-1");
    if (!appointment) throw new Error("appointment not loaded");

    const staged = await stagePaymentSuccessBells(
      tx,
      PAYMENT,
      appointment,
      "CONSULTATION",
    );

    expect(mockGlobal).not.toHaveBeenCalled();
    expect(
      upserts.map((q) => [q.create.workflowId, q.create.recipients]),
    ).toEqual([
      ["payment-success", ["booker-1"]],
      ["appointment-booked", ["booker-1", "host-1"]],
    ]);
    // The MULTI booked row is listed once per recipient; its attempts share one key.
    expect(new Set(staged.map((row) => row.id))).toEqual(
      new Set(["nx-1", "nx-2"]),
    );
  });
});
