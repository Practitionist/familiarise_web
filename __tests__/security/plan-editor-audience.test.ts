/**
 * @jest-environment node
 */

/**
 * GET /api/plans/webinars/[webinarPlanId]/editor: who may read it, and what
 * the collaborator rows in it carry. The database mock answers the loader's
 * own `select`, so a column the loader does not ask for cannot be in the body.
 */

jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));

const mockEditorDb = {
  webinarPlan: { findUnique: jest.fn() },
  consultantProfile: { findFirst: jest.fn() },
  collaborator: { findFirst: jest.fn() },
  membership: { findUnique: jest.fn(), count: jest.fn() },
};
const mockEditorAuth = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockEditorDb,
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockEditorAuth(...a),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

import { rolesWithOrgPermission } from "../../lib/auth/org-permissions";

const PROFILES: Record<string, string> = {
  "host-user": "host-profile",
  "cohost-user": "cohost-profile",
  "crew-user": "crew-profile",
  "invited-user": "invited-profile",
};
const TEAM: Record<string, { id: string; status: string; tier: string }> = {
  "cohost-profile": { id: "collab-1", status: "ACCEPTED", tier: "PRESENTER" },
  "crew-profile": { id: "collab-2", status: "ACCEPTED", tier: "CREW" },
  "invited-profile": { id: "collab-3", status: "PENDING", tier: "CREW" },
};
/** A stored collaborator row, every column. */
const STORED_COLLABORATOR = {
  id: "collab-1",
  role: "CO_HOST",
  tier: "PRESENTER",
  status: "ACCEPTED",
  revenueShareBps: 4000,
  invitedById: "host-profile",
  consultantProfileId: "cohost-profile",
};

type Select = Record<string, unknown>;
const pick = (row: Record<string, unknown>, select: Select) =>
  Object.fromEntries(
    Object.keys(select)
      .filter((key) => key in row)
      .map((key) => [key, row[key]]),
  );

function seedPlan(organizationId: string | null = null) {
  mockEditorDb.webinarPlan.findUnique.mockImplementation(
    async (args: {
      select?: Select;
      include?: { collaborators: { select: Select } };
    }) =>
      args.include
        ? {
            id: "plan-1",
            title: "Deep work",
            collaborators: [
              pick(STORED_COLLABORATOR, args.include.collaborators.select),
            ],
          }
        : {
            consultantProfileId: "host-profile",
            organizationId,
            archivedAt: null,
            organization: organizationId ? { status: "ACTIVE" } : null,
          },
  );
  mockEditorDb.consultantProfile.findFirst.mockImplementation(
    async (args: { where: { userId: string } }) =>
      PROFILES[args.where.userId] ? { id: PROFILES[args.where.userId] } : null,
  );
  mockEditorDb.collaborator.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) =>
      TEAM[args.where.consultantProfileId] ?? null,
  );
  // The named expert holds no active membership of the owning organisation.
  mockEditorDb.membership.count.mockResolvedValue(0);
  mockEditorDb.membership.findUnique.mockImplementation(
    async (args: { where: { userId_organizationId: { userId: string } } }) =>
      args.where.userId_organizationId.userId === "operator-user"
        ? {
            status: "ACTIVE",
            role: rolesWithOrgPermission("catalog.manage")[0],
          }
        : null,
  );
}

async function readAs(id: string) {
  mockEditorAuth.mockResolvedValue({ session: { user: { id } } });
  const { GET } =
    await import("../../app/api/plans/webinars/[webinarPlanId]/editor/route");
  const res = await GET(new Request("http://x") as never, {
    params: Promise.resolve({ webinarPlanId: "plan-1" }),
  });
  const body = (await res.json()) as {
    data?: { collaborators: Record<string, unknown>[] };
  };
  return { res, data: body.data };
}

beforeEach(() => jest.clearAllMocks());

describe("plan editor read", () => {
  it.each(["host-user", "cohost-user", "crew-user"])(
    "%s reads it privately, and no collaborator row carries a share",
    async (userId) => {
      seedPlan();
      const { res, data } = await readAs(userId);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(data?.collaborators[0]).toEqual({
        id: "collab-1",
        role: "CO_HOST",
      });
      expect(data?.collaborators[0]).not.toHaveProperty("revenueShareBps");
      expect(data?.collaborators[0]).not.toHaveProperty("invitedById");
    },
  );

  it("an operator of the owning organisation reads it; its named expert who is no longer active does not", async () => {
    seedPlan("org-1");
    expect((await readAs("operator-user")).res.status).toBe(200);
    expect((await readAs("host-user")).res.status).toBe(404);
  });

  it.each(["invited-user", "stranger"])(
    "%s gets the 404 of a missing plan and the plan is never loaded",
    async (userId) => {
      seedPlan();
      const { res, data } = await readAs(userId);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(data).toBeUndefined();
      expect(mockEditorDb.webinarPlan.findUnique).toHaveBeenCalledTimes(1);
    },
  );
});
