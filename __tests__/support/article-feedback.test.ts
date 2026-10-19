/**
 * @jest-environment node
 *
 * Guards the Help Center's FAQ index and the "was this helpful?" vote:
 * the article key resolves to exactly one article, the index lists every
 * article once, and the vote route refuses an unknown key, a signed-out
 * reader, a malformed body, and a throttled caller — and records the rest.
 */
import { NextRequest, NextResponse } from "next/server";

const mockUpsert = jest.fn();
const mockRequireApiSession = jest.fn();
const mockApplyRateLimit = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    get supportArticleFeedback() {
      return { upsert: mockUpsert };
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireApiSession: (...args: unknown[]) => mockRequireApiSession(...args),
}));

jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
}));

import {
  faqIndexByCategory,
  getArticleByKey,
  supportArticles,
  supportCategories,
} from "@/app/support/_data/support-content";
import { POST as postArticleFeedback } from "@/app/api/support/articles/[articleKey]/feedback/route";

const ARTICLE_KEY = "refunds-explained";

function voteRequest(articleKey: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/support/articles/${articleKey}/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("Help Center FAQ index", () => {
  it("gives every article a key that resolves to that article alone", () => {
    const slugs = supportArticles.map((a) => a.slug);
    // The vote is keyed on the slug alone, so a slug shared by two articles
    // would merge two articles' votes into one row.
    expect(new Set(slugs).size).toBe(slugs.length);

    for (const article of supportArticles) {
      expect(getArticleByKey(article.slug)).toBe(article);
    }
    expect(getArticleByKey("not-a-real-article")).toBeUndefined();
  });

  it("lists every article exactly once, grouped by category", () => {
    const groups = faqIndexByCategory();
    const listed = groups.flatMap((group) => group.articles);

    expect(listed).toHaveLength(supportArticles.length);
    expect(new Set(listed.map((a) => `${a.category}/${a.slug}`)).size).toBe(
      listed.length,
    );
    for (const group of groups) {
      expect(group.articles.length).toBeGreaterThan(0);
      expect(supportCategories).toContain(group.category);
      for (const article of group.articles) {
        expect(article.category).toBe(group.category.slug);
      }
    }
  });
});

describe("POST /api/support/articles/[articleKey]/feedback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApplyRateLimit.mockResolvedValue(null);
    mockRequireApiSession.mockResolvedValue({
      session: { user: { id: "user-1" } },
    });
    mockUpsert.mockResolvedValue({ id: "feedback-1" });
  });

  it("records one vote per reader per article", async () => {
    const res = await postArticleFeedback(
      voteRequest(ARTICLE_KEY, { helpful: true }),
      {
        params: Promise.resolve({ articleKey: ARTICLE_KEY }),
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: { articleKey: ARTICLE_KEY, helpful: true },
    });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        articleKey_userId: { articleKey: ARTICLE_KEY, userId: "user-1" },
      },
      create: { articleKey: ARTICLE_KEY, userId: "user-1", helpful: true },
      update: { helpful: true },
    });
  });

  it("refuses a signed-out reader", async () => {
    mockRequireApiSession.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await postArticleFeedback(
      voteRequest(ARTICLE_KEY, { helpful: true }),
      {
        params: Promise.resolve({ articleKey: ARTICLE_KEY }),
      },
    );

    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a key that is not a Help Center article", async () => {
    const res = await postArticleFeedback(
      voteRequest("not-a-real-article", { helpful: true }),
      {
        params: Promise.resolve({ articleKey: "not-a-real-article" }),
      },
    );

    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    const res = await postArticleFeedback(
      voteRequest(ARTICLE_KEY, { helpful: "yes" }),
      {
        params: Promise.resolve({ articleKey: ARTICLE_KEY }),
      },
    );

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("answers a throttled caller with 429 and records nothing", async () => {
    mockApplyRateLimit.mockResolvedValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );

    const res = await postArticleFeedback(
      voteRequest(ARTICLE_KEY, { helpful: true }),
      {
        params: Promise.resolve({ articleKey: ARTICLE_KEY }),
      },
    );

    expect(res.status).toBe(429);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
