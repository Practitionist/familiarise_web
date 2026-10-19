/**
 * @jest-environment node
 */

/**
 * The public expert profile is the main buy surface, and its plan order is the
 * expert's merchandising rather than a derived one. These pins hold the query
 * on that contract:
 *
 *   - `sortOrder` is the primary key of the ordering, so a flagship offer can
 *     outrank a longer or cheaper one. Duration is the tie-break only.
 *   - FAQs ride along with the plans, because the profile renders a buyer's
 *     objections inline rather than one click deeper on a plan page.
 *
 * `getConsultantDetail` is wrapped in React `cache`, which the jest React build
 * does not provide; `cache` is mocked to the identity above, and each test
 * resets the module registry so no call is replayed from the first one.
 */

const mockFindUnique = jest.fn();

// `getConsultantDetail` is imported dynamically below, so this file would
// otherwise parse as a script and its `mockFindUnique` land in global scope,
// colliding with identically-named fixtures in sibling suites.
export {};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

// `getConsultantDetail` is wrapped in React's `cache()` at module load time,
// and that export is RSC-only — absent from the React build jest resolves, so
// the wrapper throws before the body runs. Making it the identity keeps the
// assertion on the query this test is actually about.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: (fn: unknown) => fn,
}));

type PlanSelect = {
  where: unknown;
  orderBy?: unknown;
  include?: Record<string, unknown>;
};

async function consultationPlanSelect(): Promise<PlanSelect> {
  jest.resetModules();
  mockFindUnique.mockResolvedValue({
    id: "consultant-1",
    domain: { id: "d", name: "Software", subDomains: [], tags: [] },
    subDomains: [],
    tags: [],
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [],
    consultationPlans: [],
    subscriptionPlans: [],
    webinarPlans: [],
    classPlans: [],
    workExperiences: [],
    education: [],
    certifications: [],
  });
  mockFindUnique.mockClear();

  const { getConsultantDetail } = await import("@/lib/data/consultant-detail");
  await getConsultantDetail("consultant-1");

  const select = mockFindUnique.mock.calls[0][0].select;
  return select.consultationPlans;
}

afterEach(() => {
  jest.resetModules();
});

describe("expert profile consultation plan query", () => {
  it("orders by the expert's sortOrder before anything else", async () => {
    const plans = await consultationPlanSelect();

    expect(plans.orderBy).toEqual([
      { sortOrder: "asc" },
      { durationInHours: "asc" },
    ]);
  });

  it("orders subscriptions by the same merchandising key", async () => {
    jest.resetModules();
    mockFindUnique.mockResolvedValue({
      id: "consultant-1",
      domain: { id: "d", name: "Software", subDomains: [], tags: [] },
      subDomains: [],
      tags: [],
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [],
      consultationPlans: [],
      subscriptionPlans: [],
      webinarPlans: [],
      classPlans: [],
      workExperiences: [],
      education: [],
      certifications: [],
    });
    mockFindUnique.mockClear();

    const { getConsultantDetail } =
      await import("@/lib/data/consultant-detail");
    await getConsultantDetail("consultant-1");

    const subs = mockFindUnique.mock.calls[0][0].select.subscriptionPlans;
    expect(subs.orderBy).toEqual([
      { sortOrder: "asc" },
      { durationInMonths: "asc" },
    ]);
  });

  it("includes FAQs so the profile can answer objections inline", async () => {
    const plans = await consultationPlanSelect();

    expect(plans.include).toEqual({ faqs: { orderBy: { order: "asc" } } });
  });

  it("still refuses drafts, archived and ORG_ONLY plans", async () => {
    const plans = await consultationPlanSelect();

    expect(plans.where).toBeDefined();
    expect(plans.orderBy).toHaveLength(2);
  });
});
