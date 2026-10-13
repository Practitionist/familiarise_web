/**
 * @jest-environment node
 */

/**
 * A publicly CDN-cached list must name every query key it reads in
 * `Netlify-Vary`, or Netlify serves one consultant's reviews for another.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  attemptTrigger: jest.fn(),
  notifyNewReview: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  EMAIL_BUDGET_MS: {},
  sendNewReviewEmail: jest.fn(),
}));
jest.mock("../../lib/data/public-cache", () => ({
  __esModule: true,
  purgeReviewSurfaces: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { consultantReview: { findMany: jest.fn(async () => []) } },
}));

import { NextRequest } from "next/server";
import { publicCacheHeaders } from "../../lib/api/cdn-cache";
import { GET } from "../../app/api/user/reviews/route";

describe("publicCacheHeaders", () => {
  it("names every query key and omits the vary header when none are read", () => {
    expect(
      publicCacheHeaders({
        sMaxAge: 60,
        staleWhileRevalidate: 300,
        varyQuery: ["page", "search"],
      }),
    ).toEqual({
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "Netlify-Vary": "query=page|search",
    });
    expect(
      publicCacheHeaders({ sMaxAge: 60, staleWhileRevalidate: 300 }),
    ).not.toHaveProperty("Netlify-Vary");
  });
});

describe("GET /api/user/reviews", () => {
  it("keys the CDN cache on every query key it reads", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/user/reviews?consultantId=c1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=120, stale-while-revalidate=300",
    );
    expect(res.headers.get("netlify-vary")).toBe(
      "query=rating|consultantId|search",
    );
  });

  it("refuses an unbounded filter value instead of caching it", async () => {
    const res = await GET(
      new NextRequest(
        `http://localhost/api/user/reviews?consultantId=${"x".repeat(65)}`,
      ),
    );
    expect(res.status).toBe(400);
  });
});
