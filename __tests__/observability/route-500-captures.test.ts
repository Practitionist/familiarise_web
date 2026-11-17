/**
 * @jest-environment node
 */

/** A route's catch-all 500 reports the fault to Sentry and keeps its body unchanged. */
const reportSentryError = jest.fn((..._args: unknown[]) => "evt-1");
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));
const topicFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { topic: { findMany: (...a: unknown[]) => topicFindMany(...a) } },
}));
const getDomainsWithChildren = jest.fn();
jest.mock("@/lib/data/taxonomy", () => ({
  getDomainsWithChildren: () => getDomainsWithChildren(),
}));

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  validateTitle: () => true,
  validateDescription: () => true,
  containsProfanity: () => false,
}));
const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => captureException(...a),
}));
const rankAndPaginate = jest.fn();
jest.mock("@/app/api/plans/shared/plan-filters", () => ({
  ...jest.requireActual("@/app/api/plans/shared/plan-filters"),
  getClassTrendingRank: jest.fn(async () => []),
  getWebinarTrendingRank: jest.fn(async () => []),
  rankAndPaginate: (...a: unknown[]) => rankAndPaginate(...a),
}));

import { NextRequest } from "next/server";
import { GET as topicsGET } from "@/app/api/user/content/topics/route";
import { GET as domainsGET } from "@/app/api/user/content/domains/route";
import { GET as classPlansGET } from "@/app/api/plans/classes/route";
import { GET as webinarPlansGET } from "@/app/api/plans/webinars/route";

beforeEach(() => reportSentryError.mockClear());

it.each([
  [
    "topics",
    () => {
      topicFindMany.mockRejectedValueOnce(new Error("db down"));
      return topicsGET(new NextRequest("http://x/api/user/content/topics"));
    },
    { error: "An error occurred while fetching topics" },
    "content",
  ],
  [
    "domains",
    () => {
      getDomainsWithChildren.mockRejectedValueOnce(new Error("db down"));
      return domainsGET();
    },
    { error: "Internal server error" },
    "content",
  ],
  [
    "class plans, trending",
    () => {
      rankAndPaginate.mockRejectedValueOnce(new Error("db down"));
      return classPlansGET(
        new NextRequest("http://x/api/plans/classes?sort=trending"),
      );
    },
    { error: "An error occurred while fetching class plans" },
    "plans",
  ],
])(
  "%s: captures the fault, answers the same 500",
  async (_n, call, body, subsystem) => {
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(body);
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({ subsystem, expected: false }),
    );
  },
);

it("webinar plans, trending: a failed page fetch answers the route's own 500 and captures", async () => {
  rankAndPaginate.mockRejectedValueOnce(new Error("db down"));
  const res = await webinarPlansGET(
    new NextRequest("http://x/api/plans/webinars?sort=trending"),
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: "An error occurred while fetching webinar plans",
  });
  expect(captureException).toHaveBeenCalledWith(
    expect.objectContaining({ message: "db down" }),
    { tags: { subsystem: "bookings" } },
  );
});
