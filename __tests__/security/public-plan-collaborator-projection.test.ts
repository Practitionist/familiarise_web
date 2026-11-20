/**
 * @jest-environment node
 */

/**
 * Plan payloads that leave the team name a plan's co-hosts and their roles,
 * never the terms between the experts. A Prisma `include` on the collaborator
 * relation returns every column of the row, so these reads must `select` an
 * allowlist. Covered: the public plan detail and list reads (anonymous
 * callers) and the learner's own events read.
 *
 * Behavioural: each case calls the real reader and inspects the query handed
 * to Prisma, so a select that is built and then dropped still fails.
 */

import { NextRequest } from "next/server";

const webinarPlanFindUnique = jest.fn();
const classPlanFindUnique = jest.fn();
const webinarPlanFindMany = jest.fn();
const classPlanFindMany = jest.fn();
const webinarFindMany = jest.fn();
const classFindMany = jest.fn();

// The detail readers memoize with React.cache, a server-only export.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: {
      findUnique: (...args: unknown[]) => webinarPlanFindUnique(...args),
      findMany: (...args: unknown[]) => webinarPlanFindMany(...args),
      count: jest.fn().mockResolvedValue(0),
    },
    classPlan: {
      findUnique: (...args: unknown[]) => classPlanFindUnique(...args),
      findMany: (...args: unknown[]) => classPlanFindMany(...args),
      count: jest.fn().mockResolvedValue(0),
    },
    consulteeProfile: {
      findUnique: jest.fn().mockResolvedValue({ userId: "user_learner" }),
    },
    consultation: { findMany: jest.fn().mockResolvedValue([]) },
    subscription: { findMany: jest.fn().mockResolvedValue([]) },
    trial: { findMany: jest.fn().mockResolvedValue([]) },
    webinar: {
      findMany: (...args: unknown[]) => webinarFindMany(...args),
    },
    class: {
      findMany: (...args: unknown[]) => classFindMany(...args),
    },
  },
}));

jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(),
  isPrivileged: jest.fn(),
  forbiddenResponse: jest.fn(),
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

// schemas/plans loads `bad-words` (ESM-only) through utils/contentValidation.
jest.mock("../../utils/contentValidation", () =>
  jest.requireActual("../fixtures/content-validation-stub"),
);

import {
  fetchClassPlanDetail,
  fetchWebinarPlanDetail,
} from "@/lib/data/plan-details";
import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { GET as listWebinarPlans } from "@/app/api/plans/webinars/route";
import { GET as listClassPlans } from "@/app/api/plans/classes/route";

/**
 * What a surface outside the team may read of a collaborator row: its key, its
 * role and the person. Anything else on the row (the share, who invited, when
 * they answered) states the deal between the experts.
 */
const ALLOWLISTED = {
  usesInclude: false,
  fields: ["consultantProfile", "id", "role"],
};

type CollaboratorRelation = {
  include?: unknown;
  select?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every `collaborators` relation in a Prisma query, at any depth. */
function collaboratorRelationsIn(query: unknown): CollaboratorRelation[] {
  if (!isRecord(query)) return [];
  return Object.entries(query).flatMap(([key, value]) =>
    key === "collaborators" && isRecord(value)
      ? [value]
      : collaboratorRelationsIn(value),
  );
}

/** How the one query a reader sent loads the collaborator relation. */
function collaboratorProjectionOf(mock: jest.Mock) {
  if (mock.mock.calls.length !== 1) {
    throw new Error(`expected one query, saw ${mock.mock.calls.length}`);
  }
  const relations = collaboratorRelationsIn(mock.mock.calls[0][0]);
  if (relations.length !== 1) {
    throw new Error(
      `expected one collaborators relation, saw ${relations.length}`,
    );
  }
  const [relation] = relations;
  return {
    usesInclude: relation.include !== undefined,
    fields: Object.keys(relation.select ?? {}).sort(),
  };
}

const listRequest = (path: string) =>
  new NextRequest(`https://familiarise.test${path}`);

beforeEach(() => {
  jest.clearAllMocks();
  webinarPlanFindUnique.mockResolvedValue(null);
  classPlanFindUnique.mockResolvedValue(null);
  webinarPlanFindMany.mockResolvedValue([]);
  classPlanFindMany.mockResolvedValue([]);
  webinarFindMany.mockResolvedValue([]);
  classFindMany.mockResolvedValue([]);
});

describe("public plan reads select an allowlist of collaborator fields", () => {
  it("the webinar plan detail reader", async () => {
    await fetchWebinarPlanDetail("plan_w");
    expect(collaboratorProjectionOf(webinarPlanFindUnique)).toEqual(
      ALLOWLISTED,
    );
  });

  it("the class plan detail reader", async () => {
    await fetchClassPlanDetail("plan_c");
    expect(collaboratorProjectionOf(classPlanFindUnique)).toEqual(ALLOWLISTED);
  });

  it("GET /api/plans/webinars", async () => {
    const response = await listWebinarPlans(listRequest("/api/plans/webinars"));
    expect(response.status).toBe(200);
    expect(collaboratorProjectionOf(webinarPlanFindMany)).toEqual(ALLOWLISTED);
  });

  it("GET /api/plans/classes", async () => {
    const response = await listClassPlans(listRequest("/api/plans/classes"));
    expect(response.status).toBe(200);
    expect(collaboratorProjectionOf(classPlanFindMany)).toEqual(ALLOWLISTED);
  });
});

describe("the learner's events read selects an allowlist of collaborator fields", () => {
  it("for webinars and for classes", async () => {
    await readConsulteeEvents("consultee_1", { kind: "personal" });
    expect(collaboratorProjectionOf(webinarFindMany)).toEqual(ALLOWLISTED);
    expect(collaboratorProjectionOf(classFindMany)).toEqual(ALLOWLISTED);
  });
});
