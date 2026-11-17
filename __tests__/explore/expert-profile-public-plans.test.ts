/**
 * @jest-environment node
 */

/**
 * The public expert profile reads only plans a buyer can purchase and never
 * returns a strike or reliability figure, at any depth.
 */
import {
  eventPlanDiscoverableWhere,
  oneOnOnePlanDiscoverableWhere,
} from "@/lib/api/plans/visibility";

type Select = Record<string, unknown>;

/** What Prisma would return for a `select`: only the keys it names, one row per relation. */
function project(select: Select): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) row[key] = `${key}-value`;
    else if (spec && typeof spec === "object") {
      const nested = spec as { select?: Select; include?: Select };
      const inner = nested.select ?? nested.include ?? {};
      row[key] =
        key === "_count" ? project(inner) : [{ id: `${key}-1`, ...project(inner) }];
    }
  }
  return row;
}

const findUnique = jest.fn(async (args: { select: Select }) =>
  project(args.select),
);
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: (args: { select: Select }) => findUnique(args),
    },
  },
}));
// Next's server React provides `cache`; the test's React 18 build does not.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));
jest.mock("@/lib/booking/plan-demand", () => ({
  planClientsFull: jest.fn(async () => false),
}));

import { getConsultantDetail } from "@/lib/data/consultant-detail";

/** Every key in a value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
}

it("returns no strike or reliability key at any depth", async () => {
  const detail = await getConsultantDetail("cp-1");
  expect(detail).not.toBeNull();
  const keys = keysOf(detail);
  expect(keys).toContain("webinarPlans");
  expect(keys.filter((key) => /strike|reliab/i.test(key))).toEqual([]);
});

it("lists only plans a buyer can purchase", async () => {
  await getConsultantDetail("cp-2");
  const select = findUnique.mock.calls.at(-1)![0].select as Record<
    string,
    { where: unknown; include?: { classes?: { where: unknown } } }
  >;
  expect(select.consultationPlans.where).toEqual(
    oneOnOnePlanDiscoverableWhere(),
  );
  expect(select.subscriptionPlans.where).toEqual(
    oneOnOnePlanDiscoverableWhere(),
  );
  expect(select.webinarPlans.where).toEqual(eventPlanDiscoverableWhere());
  expect(select.classPlans.where).toEqual(eventPlanDiscoverableWhere());
  expect(eventPlanDiscoverableWhere().visibility.in).toEqual([
    "PUBLIC",
    "ORG_AND_PUBLIC",
  ]);
  // Each class plan shows only its next batch still to start.
  expect(select.classPlans.include?.classes?.where).toMatchObject({
    status: "SCHEDULED",
    schedulingPeriodStartsAt: { gt: expect.any(Date) },
  });
});
