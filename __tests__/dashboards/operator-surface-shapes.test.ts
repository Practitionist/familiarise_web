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
