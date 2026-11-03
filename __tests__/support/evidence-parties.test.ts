/** @jest-environment node */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  CAPTURED_PAYMENT_WHERE,
  deliveringPartiesByAppointment,
  presenterAppointmentIdsIn,
  presenterAppointmentWhere,
} from "../../lib/support/evidence-parties";
import { bookingPartyWhere } from "../../lib/moderation/report-case";

type PaymentRow = {
  hostOrganizationId: string | null;
  paymentStatus: string;
  deletedAt: Date | null;
};

type CollaboratorRow = {
  consultantProfileId: string;
  status: string;
  tier: string;
};

type ProfileRow = { id: string; user: { id: string } | null };

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

type AppointmentArgs = {
  select: {
    payment: { where: Partial<PaymentRow>; select: unknown };
    webinar: {
      select: {
        webinarPlan: {
          select: {
            collaborators: { where: Record<string, string>; select: unknown };
          };
        };
      };
    };
  };
};

function fakeDb(
  options: {
    webinarCollaborators?: CollaboratorRow[];
    profiles?: ProfileRow[];
  } = {},
) {
  const appointmentFindMany = jest.fn(async (args: AppointmentArgs) => {
    const { where } = args.select.payment;
    const rows = payments.filter((p) =>
      Object.entries(where).every(
        ([key, value]) => p[key as keyof PaymentRow] === value,
      ),
    );
    const collaboratorWhere =
      args.select.webinar?.select.webinarPlan.select.collaborators.where ?? {};
    const collaborators = (options.webinarCollaborators ?? []).filter((c) =>
      Object.entries(collaboratorWhere).every(
        ([key, value]) => c[key as keyof CollaboratorRow] === value,
      ),
    );
    return [
      {
        id: "appt-1",
        participants: [{ userId: "consultant-1" }],
        consultation: null,
        subscription: null,
        webinar: options.webinarCollaborators
          ? {
              webinarPlan: {
                consultantProfileId: "host-profile",
                collaborators,
              },
            }
          : null,
        class: null,
        payment: rows.map((p) => ({
          hostOrganizationId: p.hostOrganizationId,
        })),
      },
    ];
  });
  return {
    appointment: { findMany: appointmentFindMany },
    consultantProfile: {
      findMany: jest.fn(async () => options.profiles ?? []),
    },
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

  it("separates accepted presenters from crew while still delivering", async () => {
    const db = fakeDb({
      webinarCollaborators: [
        {
          consultantProfileId: "presenter-profile",
          status: "ACCEPTED",
          tier: "PRESENTER",
        },
        {
          consultantProfileId: "crew-profile",
          status: "ACCEPTED",
          tier: "CREW",
        },
        {
          consultantProfileId: "pending-presenter",
          status: "PENDING",
          tier: "PRESENTER",
        },
      ],
      profiles: [
        { id: "host-profile", user: { id: "host-user" } },
        { id: "presenter-profile", user: { id: "presenter-user" } },
        { id: "crew-profile", user: { id: "crew-user" } },
      ],
    });
    const parties = await deliveringPartiesByAppointment(
      db as unknown as Parameters<typeof deliveringPartiesByAppointment>[0],
      ["appt-1"],
    );
    const booking = parties.get("appt-1");
    expect([...(booking?.presenterIds ?? [])]).toEqual(["presenter-user"]);
    expect([...(booking?.deliveringIds ?? [])]).toContain("presenter-user");
    expect([...(booking?.deliveringIds ?? [])]).not.toContain("crew-user");
    const select = db.appointment.findMany.mock.calls[0][0].select;
    expect(
      select.webinar.select.webinarPlan.select.collaborators.where,
    ).toEqual({ status: "ACCEPTED", tier: "PRESENTER" });
  });
});

describe("presenterAppointmentIdsIn", () => {
  it("looks up only the page's distinct appointment IDs", async () => {
    const findMany = jest.fn(async () => [{ id: "appt-2" }]);
    const db = { appointment: { findMany } };
    const ids = await presenterAppointmentIdsIn(
      db as unknown as Parameters<typeof presenterAppointmentIdsIn>[0],
      "presenter",
      ["appt-1", "appt-2", null, "appt-1", undefined],
    );
    expect([...ids]).toEqual(["appt-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: ["appt-1", "appt-2"] } },
          presenterAppointmentWhere("presenter"),
        ],
      },
      select: { id: true },
    });
  });

  it("skips the query when the page has no appointments", async () => {
    const findMany = jest.fn();
    const db = { appointment: { findMany } };
    const ids = await presenterAppointmentIdsIn(
      db as unknown as Parameters<typeof presenterAppointmentIdsIn>[0],
      "presenter",
      [null, undefined],
    );
    expect(ids.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
