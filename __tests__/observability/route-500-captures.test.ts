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

import { NextRequest } from "next/server";
import { GET as topicsGET } from "@/app/api/user/content/topics/route";
import { GET as domainsGET } from "@/app/api/user/content/domains/route";

beforeEach(() => reportSentryError.mockClear());

it.each([
  [
    "topics",
    () => {
      topicFindMany.mockRejectedValueOnce(new Error("db down"));
      return topicsGET(new NextRequest("http://x/api/user/content/topics"));
    },
    { error: "An error occurred while fetching topics" },
  ],
  [
    "domains",
    () => {
      getDomainsWithChildren.mockRejectedValueOnce(new Error("db down"));
      return domainsGET();
    },
    { error: "Internal server error" },
  ],
])("%s: captures the fault, answers the same 500", async (_n, call, body) => {
  const res = await call();
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual(body);
  expect(reportSentryError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "db down" }),
    expect.objectContaining({ subsystem: "content", expected: false }),
  );
});
