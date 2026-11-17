/**
 * @jest-environment node
 */

/**
 * The moderation stat cards read 0 permanently — shape drift that `tsc` could
 * not see while the client type was hand-written. The route now builds its
 * body as `ModerationStatsBody` and the page parses it with the same schema
 * (`lib/backoffice/moderation-schemas.ts`), so the two cannot drift.
 *
 * The route wraps its counters in a `stats` envelope; the client returned the
 * whole envelope annotated as `ModerationStats`, so every field was
 * `undefined` and every card fell to its `?? 0`. Three of the four counter
 * names also differed between route and type, so even unwrapping would have
 * fixed only one card. And two counters measured the wrong thing entirely —
 * "Reviews to Check" was an unfiltered count of every review row ever written
 * rather than a queue, and "Resolved Today" counted the whole `?days=` window,
 * 7 by default.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";

const mockCount = jest.fn(async (_args: unknown) => 0);
jest.mock("@/lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "STAFF" } },
  }),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      count: (args: unknown) => mockCount(args),
      groupBy: async () => [],
    },
    consultantProfileVerification: { count: async () => 0 },
    moderationAction: { groupBy: async () => [] },
  },
}));

import { GET as statsGet } from "@/app/api/staff/moderation/stats/route";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("moderation stats reach the cards", () => {
  const ROUTE = read("app/api/staff/moderation/stats/route.ts");
  const CLIENT = read("components/dashboard/shared/ModerationPage.tsx");
  const SCHEMAS = read("lib/backoffice/moderation-schemas.ts");

  /** Field names declared on the shared `moderationStatsSchema`. */
  const typeFields = (() => {
    const start = SCHEMAS.indexOf(
      "export const moderationStatsSchema = z.object({",
    );
    const block = SCHEMAS.slice(start, SCHEMAS.indexOf("\n});", start));
    return Array.from(block.matchAll(/^\s+(\w+):\s*z\.number/gm), (m) => m[1]);
  })();

  /** Field names the route puts inside its `stats` envelope. */
  const routeFields = (() => {
    const start = ROUTE.indexOf("stats: {");
    const block = ROUTE.slice(start, ROUTE.indexOf("},", start));
    return Array.from(block.matchAll(/^\s+(\w+),?$/gm), (m) => m[1]);
  })();

  it("the route emits exactly the fields the shared type declares", () => {
    expect(typeFields.length).toBeGreaterThan(0);
    expect(routeFields.slice().sort()).toEqual(typeFields.slice().sort());
  });

  it("every field the cards read is one the route emits", () => {
    const readFields = Array.from(
      CLIENT.matchAll(/stats\?\.(\w+)/g),
      (m) => m[1],
    );
    expect(readFields.length).toBeGreaterThan(0);
    const unknown = readFields.filter((f) => !routeFields.includes(f));
    expect(unknown).toEqual([]);
  });

  it("the route builds, and the client parses, one schema's body and unwraps its envelope", () => {
    // Returning `response.json()` cast to the counters is the original bug:
    // it typechecks and every field is undefined at runtime.
    expect(ROUTE).toContain("const body: ModerationStatsBody = {");
    expect(CLIENT).toContain("moderationStatsBodySchema,");
    expect(CLIENT).toContain("return body.stats;");
    expect(CLIENT).not.toMatch(/as \{ stats:/);
  });

  it('"Resolved Today" counts from 00:00 IST, not the ?days= window', () => {
    expect(ROUTE).toContain(
      "const startOfToday = operatorPeriodStarts(now).day;",
    );
    expect(ROUTE).toContain("resolvedAt: { gte: startOfToday }");
    expect(ROUTE).not.toContain("setHours(0, 0, 0, 0)");
  });

  it('"Reviews to Check" counts a queue, not every review ever written', () => {
    // ConsultantReview carries no status/flag column, so the only queue a
    // review can be in is a PENDING report against it.
    expect(ROUTE).not.toContain("consultantReview.count()");
    expect(ROUTE).toContain('status: "PENDING", type: "REVIEW"');
  });
});

describe('"Resolved Today" by the clock', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    // 00:30 IST on 1 Dec is 19:00 UTC on 30 Nov: today began at 18:30 UTC on 30 Nov.
    ["2026-11-30T19:00:00.000Z", "2026-11-30T18:30:00.000Z"],
    // 23:59 IST on 30 Nov is 18:29 UTC: today began at 18:30 UTC on 29 Nov.
    ["2026-11-30T18:29:00.000Z", "2026-11-29T18:30:00.000Z"],
  ])("at %s counts resolutions from %s", async (now, start) => {
    jest.useFakeTimers({ now: new Date(now), doNotFake: ["nextTick"] });
    const res = await statsGet(
      new NextRequest("http://test/api/staff/moderation/stats"),
    );
    expect(res.status).toBe(200);
    const resolvedFilter = mockCount.mock.calls
      .map(([args]) => args as { where: { resolvedAt?: { gte: Date } } })
      .find((a) => a.where.resolvedAt);
    expect(resolvedFilter?.where.resolvedAt?.gte.toISOString()).toBe(start);
  });
});
