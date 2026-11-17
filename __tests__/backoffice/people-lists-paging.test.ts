/**
 * @jest-environment node
 */

/**
 * The people and comms lists page on the server: a bad `?page` reads as page
 * 1, a page holds at most 100 rows, every order ends on an `id` tie-break, and
 * each route's real body parses with the schema its screen reads, while a
 * malformed one is refused (the screen shows its error state).
 */

import { NextRequest } from "next/server";
import type { z } from "zod";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "ADMIN" } },
  }),
}));
jest.mock("../../lib/moderation/review-context", () => ({
  readReviewReportSignals: async () => ({}),
}));

const AT = new Date("2026-11-16T09:15:00.000Z");
const person = {
  id: "u-1",
  name: "Priya Anderson",
  email: "priya@example.test",
};

/** One realistic row per model, shaped as each route's select returns it. */
const ROWS: Record<string, unknown[]> = {
  user: [
    {
      ...person,
      image: null,
      role: "CONSULTEE",
      onboardingCompleted: true,
      createdAt: AT,
    },
  ],
  consultantProfileVerification: [
    {
      id: "v-1",
      status: "PENDING",
      submittedAt: AT,
      notes: null,
      rejectionReason: null,
      feedbackDetails: null,
      reviewedAt: null,
      reviewedById: null,
      reviewNotes: null,
      consultantProfile: {
        id: "cp-1",
        userId: "u-2",
        description: null,
        experience: 4,
        headline: "Career coach",
        user: {
          id: "u-2",
          name: "Rahul Mehta",
          email: "rahul@example.test",
          image: null,
          linkedinUrl: null,
          bio: null,
          workExperiences: [],
          certifications: [],
          education: [],
        },
        domain: { id: "d-1", name: "Careers" },
        subDomains: [],
      },
      documents: [
        {
          id: "doc-1",
          fileName: "id.pdf",
          originalName: "id.pdf",
          fileSize: 1200,
          mimeType: "application/pdf",
          description: null,
        },
      ],
    },
  ],
  organization: [
    {
      id: "org-1",
      name: "Acme Learning",
      slug: "acme",
      status: "ACTIVE",
      canSponsor: true,
      canHost: false,
      billingEmail: "billing@acme.test",
      createdAt: AT,
      billingAccount: { id: "ba-1", fundingSource: "WALLET" },
      _count: { memberships: 3, contracts: 1 },
    },
  ],
  moderationReport: [
    {
      id: "r-1",
      type: "REVIEW",
      status: "PENDING",
      reason: "SPAM",
      description: null,
      contentText: null,
      contentUrl: null,
      streamMessageId: null,
      streamChannelCid: null,
      reportCount: 1,
      reportedBy: { ...person, image: null, role: "CONSULTEE" },
      targetUser: {
        id: "u-2",
        name: "Rahul Mehta",
        email: "rahul@example.test",
        image: null,
        role: "CONSULTANT",
        banned: false,
        banExpires: null,
      },
      reviewId: "rev-1",
      review: {
        id: "rev-1",
        rating: 2,
        reviewDescription: "Late",
        appointmentId: null,
        consultantProfile: { user: { name: "Rahul Mehta" } },
      },
      organizationId: null,
      assignedToId: null,
      _count: { actions: 0 },
      actions: [],
      supportCase: null,
      createdAt: AT,
      resolvedAt: null,
    },
  ],
  consultantReview: [
    {
      id: "rev-1",
      rating: 2,
      reviewDescription: "Late",
      createdAt: AT,
      deletedAt: null,
      removedBy: null,
      isAnonymous: true,
      replyBody: null,
      repliedAt: null,
      replyDeletedAt: null,
      replyRemovedBy: null,
      editedAt: null,
      moderationActions: [],
      consultantProfile: {
        id: "cp-1",
        user: { name: "Rahul Mehta", email: "rahul@example.test", image: null },
      },
      consulteeProfile: {
        id: "ce-1",
        user: { name: "Priya Anderson", image: null },
      },
    },
  ],
  platformFeedback: [
    {
      id: "f-1",
      title: "Calendar sync",
      description: "Please add Outlook",
      rating: 4,
      category: null,
      status: "PENDING",
      user: { ...person, image: null },
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  newsletterSubscriber: [
    {
      id: "s-1",
      email: "priya@example.test",
      name: null,
      status: "SUBSCRIBED",
      source: "FOOTER",
      tags: [],
      confirmedAt: AT,
      unsubscribedAt: null,
      createdAt: AT,
    },
  ],
  announcement: [
    {
      id: "a-1",
      title: "Diwali hours",
      content: "Support replies within a day",
      isActive: true,
      startDate: null,
      endDate: null,
      backgroundColor: "#000000",
      textColor: "#FFFFFF",
      linkUrl: null,
      linkText: null,
      createdBy: "op-1",
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  platformFeeSchedule: [
    {
      id: "fs-1",
      marketplaceBps: 1500,
      ownLinkBps: 500,
      effectiveFrom: AT,
      makerUserId: "u-1",
      checkerUserId: null,
      approvedAt: null,
      reason: "Launch rates",
      createdAt: AT,
    },
  ],
};

const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => {
  const model = (name: string) => ({
    findMany: async (args: unknown) => {
      mockFindMany(name, args);
      return ROWS[name] ?? [];
    },
    count: async () => 1,
    groupBy: async () => [],
    findFirst: async () => null,
  });
  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === "$transaction"
          ? (ops: Promise<unknown>[]) => Promise.all(ops)
          : model(prop),
    },
  );
  return { __esModule: true, default: db };
});

import { readListBody } from "../../lib/backoffice/money-list-schemas";
import {
  moderationReportsPageSchema,
  moderationReviewsPageSchema,
  moderationStatsBodySchema,
} from "../../lib/backoffice/moderation-schemas";
import {
  announcementPageSchema,
  feedbackPageSchema,
  feeSchedulePageSchema,
  organizationListPageSchema,
  subscriberPageSchema,
  userListPageSchema,
  verificationQueuePageSchema,
} from "../../lib/backoffice/people-list-schemas";
import { GET as usersGet } from "../../app/api/admin/users/route";
import { GET as verificationsGet } from "../../app/api/admin/verification/route";
import { GET as organizationsGet } from "../../app/api/admin/organizations/route";
import { GET as reportsGet } from "../../app/api/staff/moderation/reports/route";
import { GET as reviewsGet } from "../../app/api/staff/moderation/reviews/route";
import { GET as statsGet } from "../../app/api/staff/moderation/stats/route";
import { GET as feedbacksGet } from "../../app/api/staff/feedbacks/route";
import { GET as newsletterGet } from "../../app/api/admin/newsletter/route";
import { GET as announcementsGet } from "../../app/api/announcements/manage/route";
import { GET as feeSchedulesGet } from "../../app/api/admin/fee-schedules/route";

const BAD_PAGING = "page=abc&limit=999&perPage=999";
const req = (path: string) =>
  new NextRequest(`http://test${path}?${BAD_PAGING}`);

interface ListCase {
  name: string;
  model: string;
  call: () => Promise<Response>;
  schema: z.ZodTypeAny;
  /** The largest page the route serves. */
  maxTake: number;
  /** Drops a required field of the first row, as a broken route would. */
  corrupt: (body: Record<string, unknown>) => void;
}

const firstOf = (body: Record<string, unknown>, key: string) =>
  (body[key] as Array<Record<string, unknown>>)[0];

const cases: ListCase[] = [
  {
    name: "users",
    model: "user",
    call: () => usersGet(req("/api/admin/users")),
    schema: userListPageSchema,
    maxTake: 20,
    corrupt: (b) => delete firstOf(b, "users").id,
  },
  {
    name: "verification queue",
    model: "consultantProfileVerification",
    call: () => verificationsGet(req("/api/admin/verification")),
    schema: verificationQueuePageSchema,
    maxTake: 100,
    corrupt: (b) => (firstOf(b, "verifications").status = "LOST"),
  },
  {
    name: "organizations",
    model: "organization",
    call: () => organizationsGet(req("/api/admin/organizations")),
    schema: organizationListPageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "data").name,
  },
  {
    name: "moderation reports",
    model: "moderationReport",
    call: () => reportsGet(req("/api/staff/moderation/reports")),
    schema: moderationReportsPageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "reports").reportedBy,
  },
  {
    name: "moderation reviews",
    model: "consultantReview",
    call: () => reviewsGet(req("/api/staff/moderation/reviews")),
    schema: moderationReviewsPageSchema,
    maxTake: 100,
    corrupt: (b) => (firstOf(b, "reviews").isAnonymous = "yes"),
  },
  {
    name: "feedback",
    model: "platformFeedback",
    call: () => feedbacksGet(req("/api/staff/feedbacks")),
    schema: feedbackPageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "feedbacks").user,
  },
  {
    name: "newsletter subscribers",
    model: "newsletterSubscriber",
    call: () => newsletterGet(req("/api/admin/newsletter")),
    schema: subscriberPageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "items").email,
  },
  {
    name: "announcements",
    model: "announcement",
    call: () => announcementsGet(req("/api/announcements/manage")),
    schema: announcementPageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "data").title,
  },
  {
    name: "fee schedules",
    model: "platformFeeSchedule",
    call: () => feeSchedulesGet(req("/api/admin/fee-schedules")),
    schema: feeSchedulePageSchema,
    maxTake: 100,
    corrupt: (b) => delete firstOf(b, "schedules").maker,
  },
];

type FindArgs = {
  skip?: number;
  take?: number;
  orderBy?: unknown;
};

beforeEach(() => mockFindMany.mockClear());

describe.each(cases)("$name", (c) => {
  it("reads page 1 for a bad page, clamps the page size and ends its order on id", async () => {
    const res = await c.call();
    expect(res.status).toBe(200);
    const [, args] = mockFindMany.mock.calls.find(([m]) => m === c.model) as [
      string,
      FindArgs,
    ];
    expect(args.skip ?? 0).toBe(0);
    expect(args.take).toBeLessThanOrEqual(c.maxTake);
    const order = [args.orderBy].flat() as Record<string, unknown>[];
    expect(order.at(-1)).toEqual({ id: "asc" });
  });

  it("parses with the screen's schema, and a malformed row is refused", async () => {
    const body = (await (await c.call()).json()) as Record<string, unknown>;
    expect(c.schema.safeParse(body).success).toBe(true);
    c.corrupt(body);
    await expect(
      readListBody(new Response(JSON.stringify(body)), c.schema, "failed"),
    ).rejects.toThrow("failed");
  });
});

it("the moderation stats body parses, and a counter of the wrong type is refused", async () => {
  const body = (await (
    await statsGet(req("/api/staff/moderation/stats"))
  ).json()) as {
    stats: Record<string, unknown>;
  };
  expect(moderationStatsBodySchema.safeParse(body).success).toBe(true);
  body.stats.pendingReports = "3";
  expect(moderationStatsBodySchema.safeParse(body).success).toBe(false);
});

it("names the fee schedule's maker with one batched user read", async () => {
  const body = (await (
    await feeSchedulesGet(req("/api/admin/fee-schedules"))
  ).json()) as { schedules: { maker: unknown; checker: unknown }[] };
  expect(body.schedules[0]).toMatchObject({ maker: person, checker: null });
  expect(mockFindMany.mock.calls.filter(([m]) => m === "user")).toHaveLength(1);
});

it("sends the author of an anonymous review to staff, with the flag", async () => {
  const body = (await (
    await reviewsGet(req("/api/staff/moderation/reviews"))
  ).json()) as {
    reviews: { isAnonymous: boolean; reviewer: { name: string } }[];
  };
  expect(body.reviews[0]).toMatchObject({
    isAnonymous: true,
    reviewer: { name: "Priya Anderson" },
  });
});

it("the verification list sends no stored document URL", async () => {
  const body = (await (
    await verificationsGet(req("/api/admin/verification"))
  ).json()) as { verifications: { documents: Record<string, unknown>[] }[] };
  expect(body.verifications[0].documents[0]).not.toHaveProperty("fileUrl");
  const [, args] = mockFindMany.mock.calls.find(
    ([m]) => m === "consultantProfileVerification",
  ) as [
    string,
    { include: { documents: { select: Record<string, boolean> } } },
  ];
  expect(args.include.documents.select).not.toHaveProperty("fileUrl");
});

it("refuses an unknown verification or organization status with 400", async () => {
  for (const call of [
    () =>
      verificationsGet(
        new NextRequest("http://test/api/admin/verification?status=LOST"),
      ),
    () =>
      organizationsGet(
        new NextRequest("http://test/api/admin/organizations?status=LOST"),
      ),
  ]) {
    const res = await call();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_STATUS" });
  }
});
