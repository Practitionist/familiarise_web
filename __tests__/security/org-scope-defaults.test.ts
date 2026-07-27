/**
 * A default scope that silently hides org-funded rows has now been found four
 * times: the consultee home feed, the consultee payments list, the chat inbox,
 * and the consultant Requests tab. Each was fixed where it was found; this file
 * pins the whole class so the fifth one fails a test instead of shipping.
 *
 * The failure mode is always the same and always quiet. Nothing errors, no row
 * is marked missing — a surface simply renders a subset and looks complete. The
 * Requests case was the worst of the four: `RequestSlotAllocationTab` fetches
 * the two endpoints an expert uses to allocate slots, both of which drop
 * org-funded rows when `orgScope` is absent. An org-sponsored subscription was
 * therefore paid for and then never scheduled, because the request to allocate
 * its slots never appeared on the only surface that can act on it.
 *
 * Why the call sites rather than the defaults: the right default genuinely
 * differs by surface. A spend report wants personal; an inbox wants everything.
 * Flipping `resolveOrgScope` to `all` would relocate the bug into the surfaces
 * this repo spent PR #1029 narrowing. So each caller states its intent, and
 * these tests make omission loud.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** ripgrep-free source sweep over the app, restricted to tracked files. */
function trackedFiles(...globs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...globs], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return out.split("\n").filter(Boolean);
}

describe("useOrgScope callers state their default", () => {
  const CALLERS = trackedFiles("app/**/*.tsx", "app/**/*.ts", "components/**/*.tsx")
    .filter((f) => read(f).includes("useOrgScope("))
    .filter((f) => !f.endsWith("hooks/useOrgScope.ts"));

  it("finds the call sites (guards against the sweep silently matching nothing)", () => {
    expect(CALLERS.length).toBeGreaterThan(0);
  });

  it.each(CALLERS)("%s passes defaultForOrgMember explicitly", (rel) => {
    const src = read(rel);
    // A bare `useOrgScope()` inherits "first-org", which pins the surface to
    // whichever org happens to be first and hides the member's personal rows
    // plus every other org's. That is never what a caller means; it is what a
    // caller forgot to say.
    expect(src).not.toMatch(/useOrgScope\(\s*\)/);
    expect(src).toContain("defaultForOrgMember");
  });
});

describe("routes that drop org rows by default are always called with a scope", () => {
  /**
   * `/api/bookings/consultations` and `/api/bookings/subscriptions` apply
   * `appointments: { none: { organizationId: { not: null } } }` when the param
   * is missing. Any caller that omits it gets B2C rows only.
   */
  const GUARDED_ENDPOINTS = [
    "/api/bookings/consultations",
    "/api/bookings/subscriptions",
  ];

  const CALLERS = trackedFiles(
    "app/**/*.ts",
    "app/**/*.tsx",
    "components/**/*.tsx",
    "hooks/**/*.ts",
  ).filter((f) => {
    if (f.startsWith("app/api/")) return false; // the routes themselves
    const src = read(f);
    return GUARDED_ENDPOINTS.some((e) => src.includes(`${e}?`));
  });

  it("finds the call sites", () => {
    expect(CALLERS.length).toBeGreaterThan(0);
  });

  it.each(CALLERS)("%s sends orgScope on every guarded fetch", (rel) => {
    const src = read(rel);
    // Every line that builds one of these URLs must carry the param. Checking
    // per line rather than per file, so a file with one correct and one
    // forgotten call still fails.
    const offenders = src
      .split("\n")
      .filter((line) =>
        GUARDED_ENDPOINTS.some((e) => line.includes(`${e}?`)),
      )
      .filter((line) => !line.includes("orgScope="));

    expect(offenders).toEqual([]);
  });
});

describe("the two guarded routes still behave as documented", () => {
  it.each([
    "app/api/bookings/consultations/route.ts",
    "app/api/bookings/subscriptions/route.ts",
  ])("%s excludes org rows when the param is absent", (rel) => {
    const src = read(rel);
    // Pinning the behaviour the callers above compensate for. If this ever
    // changes, the call-site requirement can be relaxed — but deliberately,
    // not by accident.
    //
    // The two routes phrase the exclusion differently and both are correct:
    // subscriptions uses `appointments: { none: { organizationId: not null } }`,
    // while consultations needs an OR because a consultation with no
    // Appointment row is not org-funded. Assert the behaviour, not one route's
    // wording.
    expect(src).toContain("defaultPersonal");
    expect(src).toMatch(
      /none: \{ organizationId: \{ not: null \} \}|appointment: \{ organizationId: null \}/,
    );
  });
});
