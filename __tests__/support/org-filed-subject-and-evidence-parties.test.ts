/** @jest-environment node */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    appointment: { findMany: jest.fn() },
    consultantProfile: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { readSupportCaseForViewer } from "../../lib/support/case-service";
import { visibleCaseAccess } from "../../lib/support/case-access";
import { evidenceRecipientsByAppointment } from "../../lib/support/case-actions";

const db = prisma as unknown as {
  supportCase: { findUnique: jest.Mock };
  membership: { findUnique: jest.Mock; findMany: jest.Mock };
  appointment: { findMany: jest.Mock };
  consultantProfile: { findMany: jest.Mock };
  user: { findMany: jest.Mock };
};

const at = new Date("2026-10-01T00:00:00Z");
const orgFiled = {
  id: "case-1",
  referenceNumber: "FAM-1",
  title: "Operator notes about the member",
  description: "Operator-only detail",
  category: "NO_SHOW",
  status: "OPEN",
  ownershipScope: "ORG_OPERATIONS",
  organizationId: "org-1",
  requesterUserId: "member",
  submitterUserId: "operator",
  externalRequesterEmail: null,
  deletedAt: null,
  createdAt: at,
  subjects: [],
  messages: [
    {
      id: "m1",
      seq: 1,
      sender: "USER",
      body: "Operator correspondence",
      isInternal: false,
      createdAt: at,
    },
  ],
  events: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findUnique.mockResolvedValue(orgFiled);
  db.membership.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { userId_organizationId: { userId: string } };
    }) =>
      where.userId_organizationId.userId === "co-operator"
        ? { role: "OWNER", status: "ACTIVE" }
        : null,
  );
});

describe("reading an organization-filed case", () => {
  it("gives the member it is about the summary, with no correspondence", async () => {
    const view = await readSupportCaseForViewer("case-1", {
      userId: "member",
      isStaff: false,
    });
    expect(view).toMatchObject({
      id: "case-1",
      title: "Organization support case",
      description: "",
      messages: [],
      filedByOrganizationNotice: true,
    });
    expect(JSON.stringify(view)).not.toContain("Operator");
  });

  it("still refuses anyone who is neither the subject nor holds the grant", async () => {
    await expect(
      readSupportCaseForViewer("case-1", {
        userId: "stranger",
        isStaff: false,
      }),
    ).resolves.toBeNull();
  });

  it("shows the full case to a current operator with the grant", async () => {
    const view = await readSupportCaseForViewer("case-1", {
      userId: "co-operator",
      isStaff: false,
    });
    expect(view).toMatchObject({ filedByOrganizationNotice: false });
    expect(view?.messages).toHaveLength(1);
  });

  it("lists the case for its subject while reporting no correspondence right", async () => {
    const access = await visibleCaseAccess({
      userId: "member",
      role: "CONSULTEE",
    });
    expect(access.where.OR).toContainEqual({
      requesterUserId: "member",
      NOT: { submitterUserId: "member" },
    });
    expect(access.canCorrespond(orgFiled as never)).toBe(false);
  });
});

describe("evidence parties", () => {
  it("asks only presenters and the delivering consultant, never crew collaborators", async () => {
    db.appointment.findMany.mockResolvedValue([
      {
        id: "appt-1",
        participants: [{ userId: "consultant-user" }],
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
    db.consultantProfile.findMany.mockResolvedValue([
      { id: "host-profile", user: { id: "host-user" } },
      { id: "presenter-profile", user: { id: "presenter-user" } },
    ]);
    db.user.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id })),
    );

    const byAppointment = await evidenceRecipientsByAppointment(
      prisma as never,
      ["appt-1"],
    );

    const select = db.appointment.findMany.mock.calls[0][0].select;
    expect(select.participants.where.role).toBe("CONSULTANT");
    expect(
      select.webinar.select.webinarPlan.select.collaborators.where,
    ).toEqual({
      status: "ACCEPTED",
      tier: "PRESENTER",
    });
    expect(
      byAppointment
        .get("appt-1")
        ?.map((u) => u.id)
        .sort(),
    ).toEqual(["consultant-user", "host-user", "presenter-user"]);
  });
});
