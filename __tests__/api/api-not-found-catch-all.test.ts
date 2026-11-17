/**
 * @jest-environment node
 */

/**
 * Unknown /api paths answer a JSON 404, and every real route outranks the
 * catch-all under Next's own route ordering, webhooks included.
 */
import fs from "node:fs";
import path from "node:path";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { isDynamicRoute } from "next/dist/shared/lib/router/utils/is-dynamic";

import * as catchAll from "@/app/api/[...notFound]/route";
import { config as middlewareConfig } from "@/middleware";

const CATCH_ALL = "/api/[...notFound]";

/** Every app/api route as Next names it. */
function apiRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        out.push(
          "/" +
            path.relative("app", path.dirname(full)).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(path.join("app", "api"));
  return out;
}

const routes = apiRoutes();
const statics = new Set(routes.filter((r) => !isDynamicRoute(r)));
const dynamics = getSortedRoutes(routes.filter(isDynamicRoute));

/** The route Next serves for a path: an exact static match first, then dynamics in Next's order. */
function resolve(pathname: string): string | undefined {
  if (statics.has(pathname)) return pathname;
  return dynamics.find((r) => getRouteRegex(r).re.test(pathname));
}

it.each([
  ["a static route", "/api/health", "/api/health"],
  ["a dynamic route", "/api/trials/t-1", "/api/trials/[trialId]"],
  ["the auth catch-all", "/api/auth/get-session", "/api/auth/[...all]"],
])("%s outranks the catch-all", (_kind, pathname, owner) => {
  expect(resolve(pathname)).toBe(owner);
});

it("shadows no webhook route", () => {
  const webhooks = routes.filter((r) => r.includes("webhook"));
  expect(webhooks.length).toBeGreaterThan(0);
  for (const route of webhooks) {
    const sample = route.replace(/\[[^\]]+\]/g, "x");
    expect(resolve(sample)).toBe(route);
  }
});

it.each(["/api/no-such-thing", "/api/user/a/b/c"])(
  "sends %s to the catch-all",
  (pathname) => {
    expect(resolve(pathname)).toBe(CATCH_ALL);
  },
);

it("stays inside the middleware matcher", () => {
  expect(middlewareConfig.matcher).toContain("/api/(.*)");
});

it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
  "answers %s with a JSON 404 that is never cached",
  async (method) => {
    const res = catchAll[method]();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  },
);
