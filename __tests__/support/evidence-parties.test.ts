/** @jest-environment node */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  CAPTURED_PAYMENT_WHERE,
  deliveringPartiesByAppointment,
} from "../../lib/support/evidence-parties";
import { bookingPartyWhere } from "../../lib/moderation/report-case";

type PaymentRow = {
  hostOrganizationId: string | null;
  paymentStatus: string;
  deletedAt: Date | null;
};

const payments: PaymentRow[] = [
  {
    hostOrganizationId: "org-paid",
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
  },
  {
    hostOrganizationId: "org-failed",
    paymentStatus: "FAILED",
    deletedAt: null,
  },
  {
    hostOrganizationId: "org-pending",
    paymentStatus: "PENDING",
    deletedAt: null,
  },
  {
    hostOrganizationId: "org-deleted",
    paymentStatus: "SUCCEEDED",
    deletedAt: new Date("2026-10-01T00:00:00Z"),
  },
  { hostOrganizationId: null, paymentStatus: "SUCCEEDED", deletedAt: null },
];

function fakeDb() {
  const appointmentFindMany = jest.fn(
    async (args: {
      select: {
        payment: { where: Partial<PaymentRow>; select: unknown };
      };
    }) => {
      const { where } = args.select.payment;
      const rows = payments.filter((p) =>
        Object.entries(where).every(
          ([key, value]) => p[key as keyof PaymentRow] === value,
        ),
      );
      return [
        {
          id: "appt-1",
          participants: [{ userId: "consultant-1" }],
          consultation: null,
          subscription: null,
          webinar: null,
          class: null,
          payment: rows.map((p) => ({
            hostOrganizationId: p.hostOrganizationId,
          })),
        },
      ];
    },
  );
  return {
    appointment: { findMany: appointmentFindMany },
    consultantProfile: { findMany: jest.fn(async () => []) },
  };
}

describe("deliveringPartiesByAppointment", () => {
  it("derives host organizations from captured payments only", async () => {
    const db = fakeDb();
    const parties = await deliveringPartiesByAppointment(
      db as unknown as Parameters<typeof deliveringPartiesByAppointment>[0],
      ["appt-1"],
    );

    expect(db.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          payment: {
            where: { paymentStatus: "SUCCEEDED", deletedAt: null },
            select: { hostOrganizationId: true },
          },
        }),
      }),
    );
    expect([...(parties.get("appt-1")?.hostOrganizationIds ?? [])]).toEqual([
      "org-paid",
    ]);
    expect([...(parties.get("appt-1")?.deliveringIds ?? [])]).toEqual([
      "consultant-1",
    ]);
  });

  it("uses the same payment eligibility as bookingPartyWhere", () => {
    const paymentArm = bookingPartyWhere("u-1").OR?.find(
      (arm) => "payment" in arm,
    );
    expect(paymentArm).toEqual({
      payment: { some: { userId: "u-1", ...CAPTURED_PAYMENT_WHERE } },
    });
  });
});
