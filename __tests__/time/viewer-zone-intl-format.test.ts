/**
 * @jest-environment node
 */

/**
 * `formatInViewerZone` reads the wall clock through Intl, so a time inside the
 * host's spring-forward hour prints right; it matches date-fns-tz everywhere
 * else, for every pattern the repo passes it, and refuses a token it does not
 * know rather than misprinting it.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enUS } from "date-fns/locale/en-US";
import { formatInTimeZone } from "date-fns-tz";

import {
  formatInViewerZone,
  zoneDisplayLabel,
  zoneLabel,
} from "@/lib/time/viewer-zone";

const ROOT = process.cwd();

/** Every pattern literal passed to the zoned formatters, as the source has it. */
function repoPatterns(): string[] {
  const files = execSync(
    'git grep -l -E "useZonedFormat|formatInViewerZone|formatForViewer|pattern: string\\) => string" -- app components hooks lib',
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const found = new Set<string>();
  const literal = /^(["'])([\s\S]*)\1$/;
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), "utf8");
    // Named pattern constants ("const WHEN = '…'") resolve to their literal.
    const constants = new Map(
      [...src.matchAll(/const ([A-Z_]+) = (?:"([^"]*)"|'([^']*)');/g)].map(
        (m) => [m[1], m[2] ?? m[3]],
      ),
    );
    const bound = [
      ...src.matchAll(/const ([a-zA-Z]+) = useZonedFormat\(\)/g),
    ].map((m) => m[1]);
    const helperParam =
      /format: \((?:date|iso): [^)]*pattern: string\) => string/.test(src)
        ? ["format"]
        : [];
    const callers: Array<[string, number]> = [
      ["formatInViewerZone", 2],
      ["formatForViewer", 2],
      ...[...bound, ...helperParam].map((n): [string, number] => [n, 1]),
    ];
    for (const [name, index] of callers) {
      for (const m of src.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, "g"))) {
        const args = splitArgs(src, m.index + m[0].length);
        const arg = args[index];
        if (!arg) continue;
        const lit = literal.exec(arg);
        if (lit) found.add(lit[2]);
        else if (constants.has(arg)) found.add(constants.get(arg) ?? "");
        else if (/^sameHalf \?/.test(arg))
          ["h:mm", "h:mm a"].forEach((p) => found.add(p));
      }
    }
  }
  return [...found].sort();
}

/** The top-level arguments of a call whose "(" ends at `start`. */
function splitArgs(src: string, start: number): string[] {
  const out: string[] = [];
  let depth = 1;
  let cur = "";
  let quote: string | null = null;
  for (let i = start; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c) && --depth === 0) break;
    if (c === "," && depth === 1) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PATTERNS = repoPatterns();
const ZONES = [
  "Asia/Kolkata",
  "Europe/London",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];
// Outside every host gap: midday instants across the year and both meridiems.
const INSTANTS = [
  "2026-01-05T06:07:00.000Z",
  "2026-04-14T12:45:30.000Z",
  "2026-07-19T23:59:00.000Z",
  "2026-09-30T00:01:00.000Z",
  "2026-11-16T17:30:00.000Z",
];

it("finds the repo's patterns", () => {
  expect(PATTERNS).toEqual(
    expect.arrayContaining([
      "h:mm a",
      "yyyy-MM-dd",
      "EEE, d MMM yyyy 'at' h:mm a",
      "xxx",
    ]),
  );
  expect(PATTERNS.length).toBeGreaterThanOrEqual(30);
});

/** date-fns-tz's en-US output; a trailing zone name is the pinned label ("IST", not "GMT+5:30"). */
function reference(at: string, zone: string, pattern: string): string {
  if (!pattern.endsWith(" zzz")) {
    return formatInTimeZone(at, zone, pattern, { locale: enUS });
  }
  const head = formatInTimeZone(at, zone, pattern.slice(0, -4), {
    locale: enUS,
  });
  const name =
    zone === "Asia/Kolkata"
      ? "IST"
      : formatInTimeZone(at, zone, "zzz", { locale: enUS });
  return `${head} ${name}`;
}

describe.each(PATTERNS)("pattern %p", (pattern) => {
  it("matches date-fns-tz in every zone outside a host gap", () => {
    for (const zone of ZONES) {
      for (const at of INSTANTS) {
        expect(formatInViewerZone(at, zone, pattern)).toBe(
          reference(at, zone, pattern),
        );
      }
    }
  });
});

it("prints a wall time inside the host's spring-forward hour as it is", () => {
  // 02:30 in London on 8 Mar 2026 falls in Los Angeles' 02:00–03:00 gap.
  expect(
    formatInViewerZone("2026-03-08T02:30:00.000Z", "Europe/London", "h:mm a"),
  ).toBe("2:30 AM");
  expect(
    formatInViewerZone(
      "2026-03-07T21:00:00.000Z",
      "Asia/Kolkata",
      "yyyy-MM-dd HH:mm",
    ),
  ).toBe("2026-03-08 02:30");
  expect(
    formatInViewerZone(
      "2026-03-07T17:30:00.000Z",
      "Asia/Tokyo",
      "yyyy-MM-dd HH:mm",
    ),
  ).toBe("2026-03-08 02:30");
});

it("refuses a token it does not support", () => {
  expect(() => formatInViewerZone(INSTANTS[0], "UTC", "QQQ")).toThrow(
    RangeError,
  );
  expect(() => formatInViewerZone(INSTANTS[0], "UTC", "yy")).toThrow(
    RangeError,
  );
});

it("names zones and offsets through Intl, matching date-fns-tz in en-US", () => {
  for (const zone of ZONES.filter((z) => z !== "Asia/Kolkata")) {
    for (const at of INSTANTS) {
      expect(zoneLabel(at, zone)).toBe(
        formatInTimeZone(at, zone, "zzz", { locale: enUS }),
      );
      expect(formatInViewerZone(at, zone, "xxx")).toBe(
        formatInTimeZone(at, zone, "xxx"),
      );
    }
  }
  expect(zoneLabel(INSTANTS[1], "Asia/Kolkata")).toBe("IST");
  expect(zoneLabel(INSTANTS[1], "America/Los_Angeles")).toBe("PDT");
  expect(zoneLabel(INSTANTS[0], "Europe/London")).toBe("GMT");
  expect(zoneDisplayLabel(INSTANTS[1], "Asia/Kolkata")).toBe("IST (UTC+05:30)");
  expect(zoneDisplayLabel(INSTANTS[0], "UTC")).toBe("UTC (UTC)");
});
