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
    const data = put.slice(
      put.indexOf("const data = {"),
      put.indexOf("const select = {"),
    );
    expect(data).toMatch(/\bname\b/);
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
    "app/api/admin/earnings/route.ts",
  ];

  it.each(ROUTES)("%s selects an allowlist", (rel) => {
    // Strip comments first — the fix commentary quotes the very anti-patterns
    // being asserted against, and matching those would be a false positive.
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Either the scalar allowlist itself or `publicReviewSelect`, which is
    // built on it (asserted below) and is the whole-review allowlist.
    expect(src).toMatch(/consultantPublicScalars|publicReviewSelect/);
    expect(src).not.toMatch(/consultantProfile: true/);
    expect(src).not.toMatch(/consultantProfile: \{\s*\n\s*include:/);
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

describe("the plan detail reads do not serve the host's email", () => {
  // `/api/plans/{webinars,classes}/[id]` are public and CDN-cached, and the same
  // fetchers feed all four detail pages, whose result is serialised to the
  // browser. Both [id] routes used to select `user.email` and skip the
  // visibility gate the pages apply.
  const strip = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("lib/data/plan-details.ts selects the owner without an email", () => {
    const src = strip("lib/data/plan-details.ts");
    expect(src).not.toMatch(/email\s*:\s*true/);
    expect(src).toContain("planConsultantUserSelect");
  });

  it("the shared owner select carries no email", () => {
    expect(strip("lib/api/plans/consultant-projection.ts")).not.toMatch(
      /email\s*:\s*true/,
    );
  });

  it.each([
    "app/api/plans/webinars/[webinarPlanId]/route.ts",
    "app/api/plans/classes/[classPlanId]/route.ts",
  ])("%s GET answers through the visibility gate", (rel) => {
    const src = strip(rel);
    const start = src.indexOf("export async function GET");
    const next = src.indexOf("export async function", start + 1);
    const get = src.slice(start, next === -1 ? undefined : next);
    expect(get).toContain("planDetailResponse(");
    // The cache header lives in the helper, which varies it by visibility.
    expect(get).not.toMatch(/s-maxage/);
  });
});

describe("public plan payloads do not say who holds a seat", () => {
  // Both [id] routes and both list routes are public and CDN-cached, so an
  // attendee `userId` in them is readable by anyone. A seat is a count here;
  // "am I enrolled" is read for the signed-in viewer on its own request.
  const strip = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("lib/data/plan-details.ts counts seats and never selects who holds them", () => {
    const src = strip("lib/data/plan-details.ts");
    expect(src).not.toMatch(/participants\s*:\s*\{\s*select\s*:\s*\{\s*userId/);
    expect(src).not.toMatch(/userId\s*:\s*true/);
    expect(src).toContain("seatHoldingParticipant");
  });

  it.each([
    "app/api/plans/webinars/route.ts",
    "app/api/plans/classes/route.ts",
  ])("%s has no includeRegistration door for attendee ids", (rel) => {
    const src = strip(rel);
    expect(src).not.toContain("includeRegistration");
    expect(src).not.toMatch(/participants/);
  });

  it("the shared list cache key no longer varies on includeRegistration", () => {
    expect(strip("app/api/plans/shared/plan-filters.ts")).not.toContain(
      "includeRegistration",
    );
  });

  it("the viewer's own seats come from an authenticated no-store route", () => {
    const src = read("app/api/participants/event-seats/route.ts");
    expect(src).toContain("requireApiAuth");
    expect(src).toContain("private, no-store");
    expect(src).toContain("auth.session.user.id");
  });

  it("chat membership is seeded from paid seats only", () => {
    const src = strip("lib/stream/event-channel-service.ts");
    expect(src).not.toContain("liveParticipant");
    expect(src.match(/paidParticipant\(\)/g)?.length).toBe(2);
  });
});

describe("participant rosters do not return full User rows", () => {
  it("the webinar and class roster reader narrows the user select", () => {
    // `user: true` ships phone, address, dateOfBirth, city and country on
    // every roster poll.
    const src = read("lib/api/participants/group-participants-route.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/user: true/);
    expect(src).toContain("PARTICIPANT_USER_SELECT");
  });
});
