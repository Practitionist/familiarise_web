/**
 * @jest-environment node
 */

/**
 * Collaboration readers: a collaborator's profile is the id, userId and a
 * name/avatar user select, and the plan routes read the plan owner through
 * PROFILE_OWNER_SELECT; neither can carry the sensitive profile columns.
 */

import {
  hasKey,
  readSource,
  valuesAtKey,
} from "../fixtures/consultant-projection";
import { PROFILE_OWNER_SELECT } from "../../lib/booking/list-selects";
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
  },
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: jest.fn(),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({}));
jest.mock("../../lib/stream-client", () => ({}));
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import {
  getCollaborators,
  getHostedCollaborations,
} from "../../lib/collaborators/service";

const COLLABORATOR_PROFILE = {
  select: {
    id: true,
    userId: true,
    user: { select: { name: true, image: true } },
  },
};

/** The `include` block of a collaborator read: the one that joins the profile. */
function includedProfiles(args: unknown): unknown[] {
  return valuesAtKey(valuesAtKey(args, "include"), "consultantProfile");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCollaboratorFindMany.mockResolvedValue([]);
  mockWebinarPlanFindMany.mockResolvedValue([]);
  mockClassPlanFindMany.mockResolvedValue([]);
});

describe("collaborations consultant projection (behavioural)", () => {
  it("getCollaborators joins the profile as id, userId and name/image", async () => {
    await getCollaborators("webinar", "plan-1");
    const profiles = includedProfiles(
      mockCollaboratorFindMany.mock.calls[0][0],
    );
    expect(profiles).toEqual([COLLABORATOR_PROFILE]);
  });

  it("hosted collaborations join every collaborator profile the same way", async () => {
    await getHostedCollaborations("cp-1");
    const planArgs = [
      mockWebinarPlanFindMany.mock.calls[0][0],
      mockClassPlanFindMany.mock.calls[0][0],
    ];
    for (const args of planArgs) {
      const profiles = valuesAtKey(
        valuesAtKey(args, "include"),
        "consultantProfile",
      );
      expect(profiles).toEqual([COLLABORATOR_PROFILE]);
      expect(valuesAtKey(args, "consultantProfile")).not.toContain(true);
    }
  });
});

describe("collaborations consultant projection (source)", () => {
  const service = () => readSource("lib/collaborators/service.ts");

  it("collaboratorProfileSelect is id, userId and a name/image user", () => {
    expect(service()).toMatch(
      /const collaboratorProfileSelect = \{\s*select: \{\s*id: true,\s*userId: true,\s*user: \{ select: \{ name: true, image: true \} \},\s*\},\s*\} as const;/,
    );
  });

  it("the collaborator readers use it and nothing fetches the whole profile", () => {
    const src = service();
    expect(
      src.match(/consultantProfile: collaboratorProfileSelect/g),
    ).toHaveLength(3);
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
    expect(src).not.toMatch(
      /consultantProfile: \{\s*select: \{[^}]*user: true/,
    );
  });

  it.each([
    "app/api/collaborations/class/[planId]/route.ts",
    "app/api/collaborations/webinar/[planId]/route.ts",
  ])("%s reads the plan owner as PROFILE_OWNER_SELECT", (rel) => {
    const src = readSource(rel);
    expect(src).toContain("consultantProfile: PROFILE_OWNER_SELECT");
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
  });

  it("GET /api/collaborations holds no consultantProfile include", () => {
    const src = readSource("app/api/collaborations/route.ts");
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*include:/);
  });

  it.each([
    ["collaborator profile select", COLLABORATOR_PROFILE],
    ["PROFILE_OWNER_SELECT", PROFILE_OWNER_SELECT],
  ])("%s carries no sensitive profile column", (_name, projection) => {
    expect(CONSULTANT_PII_FIELDS.filter((f) => hasKey(projection, f))).toEqual(
      [],
    );
  });
});
