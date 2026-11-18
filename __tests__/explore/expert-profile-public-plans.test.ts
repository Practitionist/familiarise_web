/**
 * @jest-environment node
 */

/**
 * The public expert profile reads only plans a buyer can purchase and never
 * returns a strike or reliability figure, at any depth.
 */
import { Prisma } from "@prisma/client";

type Select = Record<string, unknown>;
type DmmfField = { name: string; kind: string; type: string; isList: boolean };
const MODELS = new Map(
  (
    Prisma.dmmf.datamodel.models as unknown as {
      name: string;
      fields: DmmfField[];
    }[]
  ).map((m) => [m.name, m.fields]),
);

/** Public catalogue models the reader may take whole; any other wholesale relation carries private facts. */
const PUBLIC_WHOLESALE = new Set([
  // The profile's own public sections and taxonomy.
  "WorkExperience",
  "Education",
  "Certification",
  "Domain",
  "SubDomain",
  "Tag",
  // The buy surface and the published calendar.
  "ConsultationPlan",
  "SubscriptionPlan",
  "SubscriptionContent",
  "WebinarPlan",
  "ClassPlan",
  "AvailabilityWindowWeekly",
  "AvailabilityWindowCustom",
]);
/** What a wholesale read of any other model stands in for: the expert's private record. */
const PRIVATE_FACTS = { reliabilityStrikes: 2, strikeCount: 2 };

function scalarRow(model: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of MODELS.get(model) ?? []) {
    if (f.kind !== "object") row[f.name] = `${f.name}-value`;
  }
  return PUBLIC_WHOLESALE.has(model) ? row : { ...row, ...PRIVATE_FACTS };
}

/**
 * What Prisma would return: a `select` names its keys; an `include`, a bare
 * `relation: true` or a relation with no `select` returns the model's whole
 * scalar row, one row per list relation.
 */
function project(
  model: string,
  spec: Select | undefined,
  wholesale: boolean,
): Record<string, unknown> {
  const fields = MODELS.get(model) ?? [];
  const row: Record<string, unknown> = wholesale ? scalarRow(model) : {};
  for (const [key, inner] of Object.entries(spec ?? {})) {
    if (!inner) continue;
    if (key === "_count") {
      const counted = ((inner as { select?: Select }).select ?? {}) as Select;
      row[key] = Object.fromEntries(Object.keys(counted).map((k) => [k, 1]));
      continue;
    }
    const field = fields.find((f) => f.name === key);
    if (!field || field.kind !== "object") {
      row[key] = `${key}-value`;
      continue;
    }
    const nested = (inner === true ? {} : inner) as {
      select?: Select;
      include?: Select;
    };
    const child = nested.select
      ? project(field.type, nested.select, false)
      : project(field.type, nested.include, true);
    row[key] = field.isList ? [child] : child;
  }
  return row;
}

const findUnique = jest.fn(async (args: { select: Select }) =>
  project("ConsultantProfile", args.select, false),
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

it("the fixture would expose a relation read whole", () => {
  expect(keysOf(project("ConsultantProfile", { user: true }, false))).toContain(
    "reliabilityStrikes",
  );
  expect(
    keysOf(
      project("ConsultantProfile", { user: { select: { id: true } } }, false),
    ),
  ).not.toContain("reliabilityStrikes");
});

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
  const publicLive = {
    visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] },
    archivedAt: null,
  };
  const published = { ...publicLive, status: "PUBLISHED" };
  expect(select.consultationPlans.where).toEqual(published);
  expect(select.subscriptionPlans.where).toEqual(published);
  expect(select.webinarPlans.where).toEqual(publicLive);
  expect(select.classPlans.where).toEqual(publicLive);
  // Each class plan shows only its next batch still to start.
  expect(select.classPlans.include?.classes?.where).toMatchObject({
    status: "SCHEDULED",
    schedulingPeriodStartsAt: { gt: expect.any(Date) },
  });
});
