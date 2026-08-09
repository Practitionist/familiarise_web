/**
 * #1119 was never a bug in the fail-open helper's default. It was a bug in
 * call-site WIRING: a route that had become ISR was still degrading, so a
 * transient pooler timeout became a 200 that Netlify wrote into the durable cache
 * and replayed to every visitor for the whole revalidate window.
 *
 * The helper's unit tests cannot catch that class — they pass whatever the routes
 * do. This one reads the route sources directly and pins the invariant that
 * actually matters: degrading and being cacheable are mutually exclusive.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.join(process.cwd(), "app");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
    } else if (entry === "page.tsx" || entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

const files = routeFiles(APP_DIR).map((file) => ({
  rel: path.relative(process.cwd(), file),
  src: readFileSync(file, "utf8"),
}));

// A `revalidate` export is what makes a render persistable: Next stores the HTML
// and Netlify's durable cache replays it. `dynamic = "force-dynamic"` is the only
// thing that guarantees a render reaches exactly one visitor.
const isCacheable = (src: string) =>
  /export\s+const\s+revalidate\s*=/.test(src) &&
  !/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(src);
const isForceDynamic = (src: string) =>
  /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(src);
const degrades = (src: string) => /perRequest/.test(src);

describe("#1119 — a cacheable route must never fail open", () => {
  it("finds the route files it is supposed to be guarding", () => {
    // Guards against the walk silently matching nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => isCacheable(f.src))).toBe(true);
    expect(files.some((f) => degrades(f.src))).toBe(true);
  });

  it("no route with a revalidate export opts into degrading", () => {
    const offenders = files
      .filter((f) => isCacheable(f.src) && degrades(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every route that opts into degrading is force-dynamic or a Route Handler", () => {
    const offenders = files
      .filter(
        (f) =>
          degrades(f.src) &&
          !isForceDynamic(f.src) &&
          !f.rel.endsWith("route.ts"),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the degraded consultant shell is deleted, not merely unreferenced", () => {
    // Rendered, not just mentioned — the fix's own comment cites the component by
    // name, and a comment is not a regression.
    const renders = files
      .filter((f) =>
        /<ConsultantUnavailable|from ".*ConsultantUnavailable"/.test(f.src),
      )
      .map((f) => f.rel);
    expect(renders).toEqual([]);
    expect(
      existsSync(
        path.join(
          APP_DIR,
          "explore/experts/[consultantId]/components/ConsultantUnavailable.tsx",
        ),
      ),
    ).toBe(false);
  });
});
