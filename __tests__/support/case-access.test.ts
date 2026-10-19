/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { membership: { findUnique: jest.fn(), findMany: jest.fn() } },
}));
import {
  canCorrespondOnCase,
  caseCorrespondentIds,
  visibleCaseWhere,
} from "../../lib/support/case-access";
const membership = jest.requireMock<{
  default: { membership: { findUnique: jest.Mock; findMany: jest.Mock } };
}>("../../lib/prisma").default.membership;
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
