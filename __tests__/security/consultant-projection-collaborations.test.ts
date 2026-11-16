/**
 * @jest-environment node
 */

/**
 * Collaboration readers: a collaborator's profile is read as an id, at most a
 * userId, and a name/avatar user select, so no reader can carry the sensitive
 * profile columns or the response time.
 */

import {
  expectNoBareProfile,
  hasKey,
  readSource,
  valuesAtKey,
} from "../fixtures/consultant-projection";
import { CONSULTANT_PII_FIELDS } from "../../lib/data/consultant-public";

const mockCollaboratorFindMany = jest.fn();
const mockWebinarPlanFindMany = jest.fn();
const mockClassPlanFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: {
      findMany: (...a: unknown[]) => mockCollaboratorFindMany(...a),
    },
    webinarPlan: {
      findMany: (...a: unknown[]) => mockWebinarPlanFindMany(...a),
    },
    classPlan: { findMany: (...a: unknown[]) => mockClassPlanFindMany(...a) },
    payoutAccount: { findFirst: jest.fn(async () => null) },
  },
}));

import prisma from "../../lib/prisma";
import {
  getHostedCollaborations,
  getMyCollaborations,
  getOrgHostedCollaborations,
  livePlanCollaborators,
} from "../../lib/collaborators/queries";

const COLLABORATOR_PROFILE = {
  select: {
    id: true,
    userId: true,
    user: { select: { name: true, image: true } },
  },
};

/** The Prisma args of every read the four collaboration readers make. */
async function readerArgs() {
  await livePlanCollaborators(prisma, { planType: "webinar", planId: "p-1" });
  const teamRead = mockCollaboratorFindMany.mock.calls.map(([args]) => args);
  mockCollaboratorFindMany.mockClear();
  await getMyCollaborations("cp-1");
  const ownReads = mockCollaboratorFindMany.mock.calls.map(([args]) => args);
  await getHostedCollaborations("cp-1");
  await getOrgHostedCollaborations("org-1");
  const hostedReads = [
    ...mockWebinarPlanFindMany.mock.calls,
    ...mockClassPlanFindMany.mock.calls,
  ].map(([args]) => args);
  return { teamRead, ownReads, hostedReads };
}

beforeEach(() => {
  mockCollaboratorFindMany.mockResolvedValue([]);
  mockWebinarPlanFindMany.mockResolvedValue([]);
  mockClassPlanFindMany.mockResolvedValue([]);
});

describe("collaborations consultant projection (behavioural)", () => {
  it("the plan team and the hosted lists join each collaborator's profile as id, userId and name/image", async () => {
    const { teamRead, hostedReads } = await readerArgs();
    expect(teamRead).toHaveLength(1);
    expect(hostedReads).toHaveLength(4);
    for (const args of [...teamRead, ...hostedReads]) {
      const collaboratorProfiles = valuesAtKey(
        args,
        "consultantProfile",
      ).filter((profile) => hasKey(profile, "userId"));
      expect(collaboratorProfiles).toEqual([COLLABORATOR_PROFILE]);
    }
  });

  it("no reader fetches a whole profile, a sensitive column, or more of a user than a name and an avatar", async () => {
    const { teamRead, ownReads, hostedReads } = await readerArgs();
    expect(ownReads).toHaveLength(2);
    for (const args of [...teamRead, ...ownReads, ...hostedReads]) {
      const profiles = expectNoBareProfile(args);
      expect(CONSULTANT_PII_FIELDS.filter((f) => hasKey(profiles, f))).toEqual(
        [],
      );
      const userColumns = valuesAtKey(args, "user").flatMap((user) =>
        Object.keys((user as { select: object }).select),
      );
      expect(userColumns.length).toBeGreaterThan(0);
      expect(userColumns.filter((c) => c !== "name" && c !== "image")).toEqual(
        [],
      );
    }
  });

  it("an expert's own list leaves out the response time and the actor columns", async () => {
    const { ownReads } = await readerArgs();
    for (const args of ownReads) {
      expect(args.omit).toEqual({
        respondedAt: true,
        invitedById: true,
        endedByUserId: true,
      });
    }
  });
});

describe("collaborations consultant projection (source)", () => {
  it.each([
    "lib/collaborators/queries.ts",
    "lib/collaborators/viewer.ts",
    "lib/api/collaborations/plan-route.ts",
    "lib/api/collaborations/member-handlers.ts",
    "app/api/collaborations/route.ts",
  ])("%s holds no whole-profile read of a collaborator", (rel) => {
    const src = readSource(rel);
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
    expect(src).not.toMatch(
      /consultantProfile: \{\s*select: \{[^}]*user: true/,
    );
  });

  it("the collaborator profile select carries no sensitive profile column", () => {
    expect(
      CONSULTANT_PII_FIELDS.filter((f) => hasKey(COLLABORATOR_PROFILE, f)),
    ).toEqual([]);
  });
});
