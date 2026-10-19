/**
 * Source-level guards for three critical holes and the PII-leak class around
 * them. Asserted on source rather than by invoking handlers: what matters is
 * *which guard the handler reaches for* and *which shape the query uses*, and
 * standing up Supabase + BetterAuth to prove that would test the mocks.
 *
 * Every case here was verified against the running code before the fix.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("PUT /api/user/[id] cannot escalate privilege", () => {
  const src = read("app/api/user/[id]/route.ts");

  it("never writes role or email", () => {
    // The auth check admits a user editing THEMSELVES, and `role` used to flow
    // from the body straight into the update — so any consultee could PUT
    // their own id with {"role":"ADMIN"}. An email rewrite skipped
    // verification. Neither is read from the body any more.
    const put = src
      .slice(
        src.indexOf("export async function PUT("),
        src.indexOf("export async function PATCH("),
      )
      .replace(/^\s*\/\/.*$/gm, "");
    const data = put.slice(put.indexOf("data: {"), put.indexOf("select: {"));
    expect(data).not.toMatch(/\brole\b/);
    expect(data).not.toMatch(/\bemail\b/);
    expect(put).not.toMatch(/body\.(role|email)/);
  });
});

describe("POST /api/user is gone", () => {
  it("exports no POST", () => {
    expect(read("app/api/user/route.ts")).not.toMatch(
      /export async function POST\(/,
    );
  });
});

describe("consultant statutory PII is never returned by a bare include", () => {
  // ConsultantProfile carries panNumber, ibanOrAccount, swiftBic, udyamNumber
  // and tdsLowerRateCert. A Prisma `include:` returns all of them; only a
  // `select:` allowlist keeps them out. This is the #946 bug class.
  const ROUTES = [
    "app/api/user/reviews/route.ts",
    "app/api/user/reviews/[id]/route.ts",
    "app/api/dashboard/consultee/[consulteeId]/route.ts",
    "app/api/admin/earnings/route.ts",
    // The pre-cutover staff ticket route is retired (410); the canonical case
    // workspace replaced it, and the ROUTE is a thin delegate — the
    // projection lives in the read model it calls.
    "lib/support/case-workspace.ts",
  ];

  it.each(ROUTES)("%s selects an allowlist", (rel) => {
    // Strip comments first — the fix commentary quotes the very anti-patterns
    // being asserted against, and matching those would be a false positive.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Either a shared allowlist constant, or an explicit per-field `select:`
    // — both keep the statutory columns out. The dangerous shapes are the two
    // the negative assertions below pin.
    expect(
      src.match(/consultantPublicScalars|publicReviewSelect/) ??
        src.match(/consultantProfile\s*:\s*\{\s*select\s*:/),
    ).not.toBeNull();
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*\n\s*include:/);
  });

  it("the staff case workspace projects the consultant by name only", () => {
    // The workspace serves a case's booking context, and the booking carries
    // a ConsultantProfile. It must take the name and nothing else — the PII
    // columns live on the same row.
    const src = read("lib/support/case-workspace.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/panNumber|ibanOrAccount|swiftBic|udyamNumber/);
  });

  it("publicReviewSelect is built on the scalar allowlist", () => {
    expect(read("lib/data/review-public.ts")).toContain(
      "...consultantPublicScalars",
    );
  });

  // The plan reads. Two of these are PUBLIC (middleware.ts lists
  // /api/plans/classes and /api/plans/webinars), the rest answer any signed-in
  // user; all six served the whole ConsultantProfile row until 2026-09-11. The
  // write handlers in the same files still include the caller's OWN profile, so
  // only the GET slice is asserted.
  const PLAN_READS = [
    "app/api/plans/classes/route.ts",
    "app/api/plans/webinars/route.ts",
    "app/api/plans/consultations/route.ts",
    "app/api/plans/subscriptions/route.ts",
    "app/api/plans/consultations/[consultationPlanId]/route.ts",
    "app/api/plans/subscriptions/[subscriptionPlanId]/route.ts",
  ];

  it.each(PLAN_READS)("%s GET projects the consultant", (rel) => {
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const start = src.indexOf("export async function GET");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("export async function", start + 1);
    const get = src.slice(start, next === -1 ? undefined : next);
    expect(get).toContain("planConsultantSelect");
    expect(get).not.toMatch(/consultantProfile: true/);
    expect(get).not.toMatch(/consultantProfile\s*:\s*\{\s*include\s*:/);
  });

  it("the plan projection is built on the public allowlist", () => {
    const src = read("lib/api/plans/consultant-projection.ts");
    expect(src).toContain("...consultantPublicScalars");
    expect(src).not.toMatch(/panNumber|ibanOrAccount|swiftBic|email: true/);
  });

  it("the public reviews list is not serving PII to anonymous callers", () => {
    // Comments stripped: the route's own comments name the anti-pattern.
    const src = read("app/api/user/reviews/route.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // middleware.ts marks this route public and the response is CDN-cached,
    // so a leak here is world-readable and persisted at the edge.
    expect(src).toContain("publicCacheHeaders(");
    expect(src).toContain("select: publicReviewSelect");
    // The write paths too: `include` returns every scalar on the row.
    expect(src).not.toMatch(/\binclude\s*(?::|,)/);
  });
});

describe("participant rosters do not return full User rows", () => {
  const ROUTES = [
    "app/api/participants/consultations/[consultationId]/route.ts",
    "app/api/participants/subscriptions/[subscriptionId]/route.ts",
  ];

  it.each(ROUTES)("%s narrows the user select", (rel) => {
    // `user: true` shipped phone, address, dateOfBirth, city and country on
    // every roster poll. The class/ and webinar/ siblings were hardened in the
    // #946 sweep; these two were missed.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/user: true/);
    expect(src).toContain("PARTICIPANT_USER_SELECT");
  });
});
