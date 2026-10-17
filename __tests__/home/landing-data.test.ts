/** @jest-environment node */
jest.mock("next/cache", () => ({ unstable_cache: (read: unknown) => read }));
jest.mock("../../lib/supabase", () => ({
  fetchImagesFromSupabaseStorage: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { findMany: jest.fn(), count: jest.fn() },
    consultantReview: { findMany: jest.fn() },
    appointmentOccurrence: { count: jest.fn() },
    domain: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getHomeExperts, getHomeReviews, getHomeStats } from "@/lib/data/home";

const db = prisma as unknown as {
  consultantProfile: { findMany: jest.Mock; count: jest.Mock };
  consultantReview: { findMany: jest.Mock };
  appointmentOccurrence: { count: jest.Mock };
  domain: { findMany: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  db.consultantProfile.findMany.mockResolvedValue([]);
  db.consultantProfile.count.mockResolvedValue(0);
  db.consultantReview.findMany.mockResolvedValue([]);
  db.appointmentOccurrence.count.mockResolvedValue(0);
  db.domain.findMany.mockResolvedValue([]);
});

it("reads only verified live experts and publicly discoverable offerings", async () => {
  await getHomeExperts();
  const query = db.consultantProfile.findMany.mock.calls[0][0];
  expect(query.where).toEqual({
    verificationStatus: "VERIFIED",
    deletedAt: null,
  });
  expect(query.take).toBe(10);
  expect(query.select.subscriptionPlans.where).toEqual({
    visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] },
    archivedAt: null,
    status: "PUBLISHED",
  });
  expect(query.select.subscriptionPlans.take).toBe(5);
});

it("bounds curriculum previews to three public titles, excluding learning resource URLs", async () => {
  await getHomeExperts();
  const content =
    db.consultantProfile.findMany.mock.calls[0][0].select.subscriptionPlans
      .select.subscriptionContents;
  expect(content).toEqual({
    select: { id: true, title: true, order: true },
    orderBy: { order: "asc" },
    take: 3,
  });
  expect(content.select).not.toHaveProperty("contentUrl");
  expect(content.select).not.toHaveProperty("description");
});

it("derives domain shortcuts from nonempty directory domains", async () => {
  db.domain.findMany.mockResolvedValue([
    { id: "empty", name: "Empty", _count: { consultantProfiles: 0 } },
    {
      id: "career",
      name: "Career guidance",
      _count: { consultantProfiles: 2 },
    },
    { id: "tech", name: "Technology", _count: { consultantProfiles: 5 } },
  ]);
  const stats = await getHomeStats();
  expect(stats.domains).toEqual([
    { id: "tech", name: "Technology", count: 5 },
    { id: "career", name: "Career guidance", count: 2 },
  ]);
  expect(stats.consultantsByDomain["career guidance"]).toBe(2);
});

it("preserves the public review allowlist and live verified-expert gate", async () => {
  await getHomeReviews();
  const query = db.consultantReview.findMany.mock.calls[0][0];
  expect(query.where.consultantProfile).toEqual({
    deletedAt: null,
    verificationStatus: "VERIFIED",
  });
  expect(query.where.deletedAt).toBeNull();
  expect(query.select.consulteeProfile.select).toEqual({
    user: { select: { name: true, image: true } },
  });
  expect(query.select).not.toHaveProperty("consulteeProfileId");
});

it("removes anonymous reviewer identity before any page markup or RSC payload", async () => {
  db.consultantReview.findMany.mockResolvedValue([
    {
      id: "anonymous",
      rating: 5,
      isAnonymous: true,
      reviewDescription: "Helpful advice.",
      consulteeProfile: {
        user: { name: "Private Person", image: "private-photo" },
      },
      appointmentId: "private-booking",
      ratingUnitId: "private-unit",
      replyDeletedAt: null,
    },
  ]);
  const [review] = await getHomeReviews();
  expect(review.consulteeProfile).toBeNull();
  expect(review.appointmentId).toBeNull();
  expect(review.ratingUnitId).toBeNull();
  expect(JSON.stringify(review)).not.toContain("Private Person");
  expect(JSON.stringify(review)).not.toContain("private-photo");
});
