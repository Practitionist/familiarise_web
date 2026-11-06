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
  ORG_FILED_CASE_TITLE,
  ORG_SENSITIVE_PERSONAL_CATEGORIES,
  ORG_SENSITIVE_PERSONAL_ISSUE_TYPES,
  canCorrespondOnCase,
  projectCaseForViewer,
  caseCorrespondentIds,
  casePresenterIds,
  visibleCaseAccess,
  visibleCaseWhere,
} from "../../lib/support/case-access";
import { presenterAppointmentWhere } from "../../lib/support/evidence-parties";
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
it("lists a presenter's ordinary cases through a relational predicate, not an ID list", async () => {
  const access = await visibleCaseAccess({
    userId: "presenter",
    role: "CONSULTEE",
  });
  expect(access.where.OR).toContainEqual({
    externalRequesterEmail: null,
    AND: [
      { appointment: { is: presenterAppointmentWhere("presenter") } },
      {
        OR: [
          { category: null },
          { category: { notIn: [...ORG_SENSITIVE_PERSONAL_CATEGORIES] } },
        ],
      },
      {
        OR: [
          { issueType: null },
          {
            issueType: { notIn: [...ORG_SENSITIVE_PERSONAL_ISSUE_TYPES] },
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(access.where)).not.toContain("appointmentId");
  expect(appointment.findMany).not.toHaveBeenCalled();
});

it("marks a row presenter only when the page lookup proves it and the case is safe", async () => {
  const access = await visibleCaseAccess({
    userId: "presenter",
    role: "CONSULTEE",
  });
  const row = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    submitterUserId: "learner",
    appointmentId: "appt-presenter",
    externalRequesterEmail: null,
    category: null,
    issueType: null,
  };
  const page = new Set(["appt-presenter"]);
  expect(access.canCorrespond(row, page)).toBe(true);
  expect(access.isPresenter(row, page)).toBe(true);
  expect(
    access.isPresenter({ ...row, appointmentId: "appt-other" }, page),
  ).toBe(false);
  expect(access.isPresenter(row, new Set())).toBe(false);
});

it.each(ORG_SENSITIVE_PERSONAL_CATEGORIES)(
  "hides a %s complaint from the presenter it is about",
  async (category) => {
    const access = await visibleCaseAccess({
      userId: "presenter",
      role: "CONSULTEE",
    });
    const row = {
      ownershipScope: "PERSONAL" as const,
      organizationId: null,
      submitterUserId: "learner",
      appointmentId: "appt-presenter",
      externalRequesterEmail: null,
      category,
      issueType: null,
    };
    const page = new Set(["appt-presenter"]);
    expect(access.canCorrespond(row, page)).toBe(false);
    expect(access.isPresenter(row, page)).toBe(false);
  },
);

it("hides a sensitive issue type even when the category is null", async () => {
  const access = await visibleCaseAccess({
    userId: "presenter",
    role: "CONSULTEE",
  });
  const row = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    submitterUserId: "learner",
    appointmentId: "appt-presenter",
    externalRequesterEmail: null,
    category: null,
    issueType: "WRONG_CONSULTANT" as const,
  };
  const page = new Set(["appt-presenter"]);
  expect(access.canCorrespond(row, page)).toBe(false);
  expect(access.isPresenter(row, page)).toBe(false);
});

it("never grants presenter access to an anonymous external requester's case", async () => {
  const access = await visibleCaseAccess({
    userId: "presenter",
    role: "CONSULTEE",
  });
  const row = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    submitterUserId: "learner",
    appointmentId: "appt-presenter",
    externalRequesterEmail: "outside@example.invalid",
    category: null,
    issueType: null,
  };
  const page = new Set(["appt-presenter"]);
  expect(access.canCorrespond(row, page)).toBe(false);
  expect(access.isPresenter(row, page)).toBe(false);
});

it("resolves presenters from the booking's accepted collaborators only", async () => {
  appointment.findMany.mockResolvedValue([
    {
      id: "appt-presenter",
      participants: [],
      consultation: null,
      subscription: null,
      webinar: {
        webinarPlan: {
          consultantProfileId: "host-profile",
          collaborators: [{ consultantProfileId: "presenter-profile" }],
        },
      },
      class: null,
      payment: [],
    },
  ]);
  consultantProfile.findMany.mockResolvedValue([
    { id: "host-profile", user: { id: "host" } },
    { id: "presenter-profile", user: { id: "presenter" } },
  ]);
  const supportCase = {
    appointmentId: "appt-presenter",
    externalRequesterEmail: null,
    category: null,
    issueType: null,
  };
  expect(await casePresenterIds(supportCase)).toEqual(["presenter"]);
  appointment.findMany.mockClear();
  expect(
    await casePresenterIds({ ...supportCase, category: "SAFETY_CONCERN" }),
  ).toEqual([]);
  expect(appointment.findMany).not.toHaveBeenCalled();
});

it("redacts a self-filed case for a viewer without a current thread grant", () => {
  const row = {
    ...personal,
    id: "case-1",
    requesterUserId: "filer",
    referenceNumber: "FAM-2026-000001",
    status: "OPEN" as const,
    category: "PAYMENT_STATUS",
    createdAt: new Date("2026-10-19T10:00:00Z"),
    title: "Private payment details",
  };
  expect(projectCaseForViewer(row, "revoked-presenter", false)).toMatchObject({
    summaryOnly: true,
    summary: { title: ORG_FILED_CASE_TITLE },
  });
  expect(projectCaseForViewer(row, "filer", true).summaryOnly).toBe(false);
  expect(
    projectCaseForViewer(row, "accepted-presenter", true).summaryOnly,
  ).toBe(false);
});
