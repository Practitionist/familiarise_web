/**
 * @jest-environment node
 */

// Invariant: the landing stats, the explore metadata and the expert page keep
// one read in flight on a one-connection pool, with unchanged results.

jest.mock("next/cache", () => ({
  unstable_cache: <F>(fn: F) => fn,
}));
jest.mock("@/lib/supabase", () => ({
  fetchImagesFromSupabaseStorage: async () => [],
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { count: jest.fn(), findMany: jest.fn() },
    appointmentOccurrence: { count: jest.fn() },
    domain: { findMany: jest.fn() },
    workExperience: { findMany: jest.fn() },
  },
}));
jest.mock("@/lib/data/consultant-detail", () => ({
  getConsultantDetail: jest.fn(),
  getConsultantReviews: jest.fn(),
  getConsultantReviewTracks: jest.fn(),
}));
jest.mock("@/lib/data/digital-products-public", () => ({
  getConsultantDigitalProducts: jest.fn(),
}));
jest.mock("@/lib/seo/expert-profile", () => ({
  expertProfileJsonLd: () => ({}),
  expertProfileMetadata: () => ({}),
}));
jest.mock("@/app/explore/experts/[consultantId]/ExpertProfileClient", () => ({
  ExpertProfileClient: () => null,
}));
jest.mock(
  "@/app/explore/experts/[consultantId]/components/ConsultantSkeletonLoader",
  () => ({ ConsultantSkeletonLoader: () => null }),
);

import prisma from "@/lib/prisma";
import * as detail from "@/lib/data/consultant-detail";
import * as products from "@/lib/data/digital-products-public";
import { getHomeStats } from "@/lib/data/home";
import { fetchExpertsMetadata } from "@/lib/data/explore-experts";
import ExpertProfile from "@/app/explore/experts/[consultantId]/page";

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const loaders = [
  detail.getConsultantDetail,
  detail.getConsultantReviews,
  detail.getConsultantReviewTracks,
  products.getConsultantDigitalProducts,
] as unknown as jest.Mock[];

let inFlight = 0;
let peak = 0;
/** Every mocked read takes a tick and records how many overlap. */
function slow<A, R>(fn: (args: A) => R) {
  return async (args: A) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return fn(args);
  };
}

type Args = { where?: { isIndependent?: boolean }; select?: object };
const DOMAINS = [
  {
    id: "d1",
    name: "Tech",
    subDomains: [{ id: "s1", name: "Web", domainId: "d1" }],
    tags: [{ id: "t1", name: "React", domainId: "d1" }],
    _count: { consultantProfiles: 3 },
  },
];

const ORIGINAL_POOL = process.env.PG_POOL_MAX;
beforeEach(() => {
  inFlight = 0;
  peak = 0;
  process.env.PG_POOL_MAX = "1";
  db.consultantProfile.count.mockImplementation(
    slow(({ where }: Args) =>
      where?.isIndependent === undefined ? 5 : where.isIndependent ? 3 : 2,
    ),
  );
  db.consultantProfile.findMany.mockImplementation(
    slow(({ select }: Args) =>
      select && "languages" in select
        ? [{ languages: ["Hindi", "English"] }, { languages: ["English"] }]
        : [{ publishedRatingOneToOne: 4.5, ratedClientsOneToOne: 2 }],
    ),
  );
  db.appointmentOccurrence.count.mockImplementation(slow(() => 7));
  db.domain.findMany.mockImplementation(slow(() => DOMAINS));
  db.workExperience.findMany.mockImplementation(
    slow(() => [{ company: "Acme" }]),
  );
  for (const loader of loaders) loader.mockImplementation(slow(() => []));
  loaders[0].mockImplementation(slow(() => ({ id: "cp-1", user: {} })));
});
afterAll(() => {
  process.env.PG_POOL_MAX = ORIGINAL_POOL;
});

it("landing stats: one read in flight, two counts and two list reads", async () => {
  const stats = await getHomeStats();
  expect(peak).toBe(1);
  expect(db.consultantProfile.count).toHaveBeenCalledTimes(1);
  expect(db.appointmentOccurrence.count).toHaveBeenCalledTimes(1);
  expect(db.consultantProfile.findMany).toHaveBeenCalledTimes(1);
  expect(db.domain.findMany).toHaveBeenCalledTimes(1);
  expect(stats).toEqual({
    totalConsultants: 5,
    averageRating: 4.5,
    publishedReviewCount: 2,
    completedSessions: 7,
    consultantsByDomain: { tech: 3 },
  });
});

it("explore metadata: one read in flight, four counts and four list reads", async () => {
  const metadata = await fetchExpertsMetadata();
  expect(peak).toBe(1);
  expect(db.consultantProfile.count).toHaveBeenCalledTimes(3);
  expect(db.appointmentOccurrence.count).toHaveBeenCalledTimes(1);
  expect(db.consultantProfile.findMany).toHaveBeenCalledTimes(2);
  expect(db.domain.findMany).toHaveBeenCalledTimes(1);
  expect(db.workExperience.findMany).toHaveBeenCalledTimes(1);
  expect(metadata).toEqual({
    domains: [{ id: "d1", name: "Tech" }],
    subdomains: [{ id: "s1", name: "Web", domainId: "d1" }],
    tags: [{ id: "t1", name: "React", domainId: "d1" }],
    consultantMetadata: {
      totalConsultants: 5,
      affiliationCounts: { all: 5, independent: 3, agency: 2 },
      consultantsByDomain: [{ id: "d1", name: "Tech", consultantCount: 3 }],
      averageRating: 4.5,
      publishedReviewCount: 2,
      completedSessions: 7,
    },
    availableLanguages: ["English", "Hindi"],
    availableCompanies: ["Acme"],
  });
});

it("expert page: its four loaders run one at a time", async () => {
  await ExpertProfile({ params: Promise.resolve({ consultantId: "cp-1" }) });
  expect(peak).toBe(1);
  for (const loader of loaders) expect(loader).toHaveBeenCalledWith("cp-1");
});
