/**
 * @jest-environment node
 */

/**
 * A time a person reads is printed through Intl (`formatInViewerZone`,
 * `lib/time/display.ts`), never date-fns-tz `formatInTimeZone`, which builds a
 * host-local Date and prints a wall time inside the browser's spring-forward
 * hour an hour late. UI code under app/ and components/ never imports it;
 * server zone math in lib/ and utils/ may, and each such file is listed here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
// Built from parts so this file is not itself a match.
const IMPORT = new RegExp(
  `import[^;]*\\b${["formatIn", "TimeZone"].join("")}\\b[^;]*from\\s+["']date-fns-tz["']`,
);

/** Server zone math allowed to use date-fns-tz, each with its reason. */
const ALLOWED: Record<string, string> = {
  "lib/appointments/session-schedule.ts":
    "day keys in the scheduling zone and UTC date-range labels",
  "lib/booking/batch-cards.ts": "batch weekday and day labels in the plan zone",
  "lib/booking/class-pattern.ts":
    "projects a weekly pattern onto dates in the class zone",
  "lib/booking/entitlement.ts": "cycle boundaries in the scheduling zone",
  "lib/booking/week-nudge.ts": "the week a nudge counts, in the host zone",
  "lib/dashboard/earnings-state.ts": "payout-day labels in the payout zone (IST)",
  "lib/data/consultant-dashboard.ts": "server-side day buckets for the home tab",
  "lib/scheduling/grid-quota.ts": "per-day and per-week quota keys",
  "lib/stream/search-date.ts": "parses a typed search date in a zone",
  "utils/schedule/weekly-projection.ts":
    "projects weekly windows onto dates in a zone",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const importers = (dir: string) =>
  sourceFiles(join(ROOT, dir))
    .filter((file) => IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));

it.each(["app", "components"])(
  "no file under %s/ imports formatInTimeZone",
  (dir) => {
    expect(importers(dir)).toEqual([]);
  },
);

it("lib/ and utils/ import it only in the listed server zone math", () => {
  const found = [...importers("lib"), ...importers("utils")].sort();
  expect(found).toEqual(Object.keys(ALLOWED).sort());
});
