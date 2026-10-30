/**
 * @jest-environment node
 */

/**
 * A host-org operator's cancel is consultant-initiated (full refund) but is
 * not the expert's act, so it records no reliability strike; the expert's own
 * cancel still does, and an operator who bought the booking is held to the
 * buyer's tier.
 */

const membership = { role: "MANAGER", status: "ACTIVE" };
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: {
      findUnique: jest.fn(async () => ({
        ...membership,
        organization: { status: "ACTIVE" },
      })),
    },
  },
}));
jest.mock("@/lib/booking/org-actor", () => ({
  resolveOrgActor: jest.fn(async () => null),
}));

import { resolveCancelActor } from "@/lib/booking/cancel-actor";

const appointment = {
  organizationId: "org-host",
  consultation: {
    requestedById: "cee-buyer",
    requestedBy: { user: { id: "u-buyer" } },
    consultationPlan: {
      consultantProfileId: "cp-expert",
      organizationId: "org-host",
      consultantProfile: { user: { id: "u-expert" } },
    },
  },
  subscription: null,
  webinar: null,
  class: null,
};

it("a host-org operator cancels at the consultant tier without striking the expert", async () => {
  const actor = await resolveCancelActor(appointment, {
    id: "u-operator",
    role: "CONSULTEE",
  });
  expect(actor.isHostOrgOperator).toBe(true);
  expect(actor.isConsultantInitiated).toBe(true);
  expect(actor.isExpertSideCancel).toBe(false);
});

it("the expert's own cancel still earns the strike", async () => {
  const actor = await resolveCancelActor(appointment, {
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-expert",
  });
  expect(actor.isExpertSideCancel).toBe(true);
  expect(actor.isConsultantInitiated).toBe(true);
});

it("an operator who is also the buyer cancels as the buyer: no strike, buyer tier", async () => {
  const actor = await resolveCancelActor(appointment, {
    id: "u-buyer",
    role: "CONSULTEE",
    consulteeProfileId: "cee-buyer",
  });
  expect(actor.isConsultantInitiated).toBe(false);
  expect(actor.isExpertSideCancel).toBe(false);
});
