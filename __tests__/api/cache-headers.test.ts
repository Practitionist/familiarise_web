/**
 * Cache-directive invariants for API routes.
 *
 * A missing `Cache-Control` on a shared-cacheable surface is a correctness
 * bug, not a perf nit: Netlify's CDN replays whatever the function returns,
 * so a privileged response cached under a public URL leaks across users
 * (see `app/api/user/consultants/[id]`), and a machine/cron answer cached
 * at the edge poisons monitors. These tests read route sources directly —
 * same technique as `isr-routes-never-fail-open` — because the invariant is
 * about wiring, not runtime behavior.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const API_DIR = path.join(process.cwd(), "app", "api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

const files = routeFiles(API_DIR).map((file) => ({
  rel: path.relative(process.cwd(), file).replace(/\\/g, "/"),
  src: readFileSync(file, "utf8"),
}));

const hasGet = (src: string) => /export\s+async\s+function\s+GET\b/.test(src);
const hasNoStore = (src: string) => /no-store/.test(src);
const hasPublicCache = (src: string) => /public,\s*s-maxage=/.test(src);

describe("API cache directives", () => {
  it("finds the route files it is supposed to be guarding", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => hasGet(f.src))).toBe(true);
  });

  it("cron/machine twins never sit in the shared cache", () => {
    // Every cleanup route answers with machine JSON behind CRON_SECRET.
    // An edge-cached "ok" would blind every monitor polling it.
    const offenders = files
      .filter(
        (f) =>
          f.rel.startsWith("app/api/cleanup/") &&
          hasGet(f.src) &&
          !hasNoStore(f.src),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("privileged consultant detail never shares its cache entry", () => {
    // The [id] route serves a redacted public projection AND a privileged
    // (own-profile/admin) projection from one URL. The header must branch
    // with the access level — a single shared `public` directive leaks.
    const file = files.find(
      (f) => f.rel === "app/api/user/consultants/[id]/route.ts",
    );
    expect(file).toBeDefined();
    expect(file!.src).toMatch(/isPrivilegedAccess[\s\S]{0,200}private/);
    expect(file!.src).toMatch(/private,\s*no-store/);
  });

  it("public listings declare their shared cache window", () => {
    const expectedPublic = [
      "app/api/user/consultants/route.ts",
      "app/api/organizations/public/route.ts",
      "app/api/explore/recordings/route.ts",
      "app/api/currency/route.ts",
      "app/api/topics/route.ts",
      "app/api/programs/stats/route.ts",
    ];
    for (const rel of expectedPublic) {
      const file = files.find((f) => f.rel === rel);
      expect(file).toBeDefined();
      expect(hasPublicCache(file!.src)).toBe(true);
    }
  });
});
