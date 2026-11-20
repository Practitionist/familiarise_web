/**
 * @jest-environment node
 */

// A booking's notice is scoped per side: the expert and team by the plan's host
// organisation, each buyer by their sponsor.

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
const mockBooked = jest.fn(async (..._a: unknown[]) => []);
const mockPaid = jest.fn(async (..._a: unknown[]) => ({ success: true }));
jest.mock("../../lib/novu", () => ({
  notifyAppointmentBooked: (...a: unknown[]) => mockBooked(...a),
  notifyPaymentSuccess: (...a: unknown[]) => mockPaid(...a),
}));

import { bookingNoticeScopes } from "@/lib/novu/workflows";
import {
  stagePaymentSuccessBells,
  type AppointmentForEmails,
} from "@/lib/payments/webhooks/staged-emails";
import type { Tx } from "@/lib/prisma";

beforeEach(() => jest.clearAllMocks());

describe("bookingNoticeScopes", () => {
  it("puts the delivery side in the plan's host organisation and each buyer in their sponsor's", () => {
    expect(
      bookingNoticeScopes({
        hostOrganizationId: null,
        hostUserIds: ["expert", "cohost"],
        buyers: [
          { userId: "learner-a", organizationId: "org-sponsor" },
          { userId: "learner-b", organizationId: null },
        ],
      }),
    ).toEqual([
      { organizationId: null, userIds: ["expert", "cohost", "learner-b"] },
      { organizationId: "org-sponsor", userIds: ["learner-a"] },
    ]);
  });

  it("keeps a person who is on both sides on the delivery side, once", () => {
    expect(
      bookingNoticeScopes({
        hostOrganizationId: "org-host",
        hostUserIds: ["expert", null, undefined],
        buyers: [
          { userId: "expert", organizationId: "org-sponsor" },
          { userId: "learner", organizationId: "org-sponsor" },
          { userId: "learner", organizationId: "org-sponsor" },
        ],
      }),
    ).toEqual([
      { organizationId: "org-host", userIds: ["expert"] },
      { organizationId: "org-sponsor", userIds: ["learner"] },
    ]);
  });
});

it("a paid sponsored booking on the expert's own plan: the expert's booked bell is personal, the payer's is the sponsor's", async () => {
  const appointment = {
    id: "appt-1",
    organizationId: "org-sponsor",
    organization: { name: "Acme Ltd" },
    occurrences: [
      {
        startsAt: new Date("2026-12-01T04:30:00Z"),
        endsAt: new Date("2026-12-01T05:30:00Z"),
      },
    ],
    consultation: {
      consultationPlan: {
        title: "Career chat",
        organizationId: null,
        consultantProfile: { user: { id: "expert", name: "Dr Rao" } },
      },
    },
    subscription: null,
    webinar: null,
    class: null,
    trial: null,
  } as unknown as AppointmentForEmails;
  const payment = {
    id: "pay-1",
    userId: "learner",
    amount: 500,
    currency: "INR",
    user: { name: "Priya", email: "priya@example.test" },
  } as unknown as Parameters<typeof stagePaymentSuccessBells>[1];

  await stagePaymentSuccessBells(
    {} as Tx,
    payment,
    appointment,
    "CONSULTATION",
  );

  const [expert, learner] = mockBooked.mock.calls as unknown as [
    string[],
    {
      scope: string;
      organizationId: string | null;
      orgName?: string;
      dashboardUrl: string;
    },
  ][];
  expect(expert[0]).toEqual(["expert"]);
  expect(expert[1]).toMatchObject({ scope: "personal", organizationId: null });
  expect(expert[1].dashboardUrl).toContain("/dashboard/go/auto/appointments");
  expect(learner[0]).toEqual(["learner"]);
  expect(learner[1]).toMatchObject({
    scope: "org",
    organizationId: "org-sponsor",
    orgName: "Acme Ltd",
  });
  expect(learner[1].dashboardUrl).toContain(
    "/dashboard/organization/org-sponsor/appointments",
  );
});
