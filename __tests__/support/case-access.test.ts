/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: { findUnique: jest.fn(), findMany: jest.fn() },
    appointment: { findMany: jest.fn() },
    consultantProfile: { findMany: jest.fn() },
  },
}));
import {
  canCorrespondOnCase,
  caseCorrespondentIds,
  visibleCaseAccess,
  visibleCaseWhere,
} from "../../lib/support/case-access";
const prismaMock = jest.requireMock<{
  default: {
    membership: { findUnique: jest.Mock; findMany: jest.Mock };
    appointment: { findMany: jest.Mock };
    consultantProfile: { findMany: jest.Mock };
  };
}>("../../lib/prisma").default;
const membership = prismaMock.membership;
const appointment = prismaMock.appointment;
const consultantProfile = prismaMock.consultantProfile;
const personal = {
  ownershipScope: "PERSONAL" as const,
  organizationId: "org",
  requesterUserId: "subject",
  submitterUserId: "filer",
  externalRequesterEmail: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  membership.findMany.mockResolvedValue([]);
  membership.findUnique.mockResolvedValue(null);
  appointment.findMany.mockResolvedValue([]);
  consultantProfile.findMany.mockResolvedValue([]);
});
it("organization tagging does not grant access to a member's personal correspondence", async () => {
  expect(
    await canCorrespondOnCase(personal, {
      userId: "subject",
      role: "CONSULTEE",
    }),
  ).toBe(false);
  expect(
    await canCorrespondOnCase(personal, { userId: "filer", role: "CONSULTEE" }),
  ).toBe(true);
  expect(membership.findUnique).not.toHaveBeenCalled();
});
it.each([
  ["OWNER", true, true],
  ["MAINTAINER", true, true],
  ["MANAGER", true, false],
  ["SUPPORT", true, false],
  ["BILLING_ADMIN", false, true],
  ["LEARNER", false, false],
] as const)(
  "%s has the correct operations and billing correspondence grants",
  async (role, operations, billing) => {
    membership.findUnique.mockResolvedValue({ role, status: "ACTIVE" });
    expect(
      await canCorrespondOnCase(
        { ...personal, ownershipScope: "ORG_OPERATIONS" },
        { userId: "successor", role: "ORG_WORKSPACE" },
      ),
    ).toBe(operations);
    expect(
      await canCorrespondOnCase(
        { ...personal, ownershipScope: "ORG_BILLING" },
        { userId: "successor", role: "ORG_WORKSPACE" },
      ),
    ).toBe(billing);
  },
);
it("the original filer loses organization correspondence when their membership ends", async () => {
  membership.findUnique.mockResolvedValue({ role: "OWNER", status: "REMOVED" });
  expect(
    await canCorrespondOnCase(
      { ...personal, ownershipScope: "ORG_BILLING" },
      { userId: "filer", role: "ORG_WORKSPACE" },
    ),
  ).toBe(false);
});
it("billing notifications go only to current eligible correspondents", async () => {
  membership.findMany.mockResolvedValue([
    { userId: "owner", role: "OWNER" },
    { userId: "support", role: "SUPPORT" },
    { userId: "billing", role: "BILLING_ADMIN" },
  ]);
  expect(
    await caseCorrespondentIds({ ...personal, ownershipScope: "ORG_BILLING" }),
  ).toEqual(["owner", "billing"]);
  expect(membership.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId: "org", status: "ACTIVE" },
    }),
  );
});
it("external complainants cannot be mistaken for the queue custodian's personal cases", async () => {
  expect(
    await canCorrespondOnCase(
      { ...personal, externalRequesterEmail: "outside@example.invalid" },
      { userId: "filer", role: "CONSULTEE" },
    ),
  ).toBe(false);
  expect(
    await visibleCaseWhere({ userId: "filer", role: "CONSULTEE" }),
  ).toMatchObject({ externalRequesterEmail: null });
});
it("lists a case linked to an appointment the viewer presents and marks it presenter", async () => {
  appointment.findMany.mockResolvedValue([{ id: "appt-presenter" }]);
  const access = await visibleCaseAccess({
    userId: "presenter",
    role: "CONSULTEE",
  });
  expect(access.where.OR).toContainEqual({
    appointmentId: { in: ["appt-presenter"] },
  });
  const row = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    submitterUserId: "learner",
    appointmentId: "appt-presenter",
  };
  expect(access.canCorrespond(row)).toBe(true);
  expect(access.isPresenter(row)).toBe(true);
  expect(access.isPresenter({ ...row, appointmentId: "appt-other" })).toBe(
    false,
  );
});
it("adds no presenter clause when the viewer presents no appointment", async () => {
  appointment.findMany.mockResolvedValue([]);
  const access = await visibleCaseAccess({
    userId: "learner",
    role: "CONSULTEE",
  });
  expect(
    access.where.OR?.some(
      (clause) => typeof clause === "object" && "appointmentId" in clause,
    ),
  ).toBe(false);
});
