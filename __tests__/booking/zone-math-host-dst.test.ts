/**
 * @jest-environment node
 */

/**
 * Class series and plan ends read the zone's wall clock through Intl, so a
 * browser in Los Angeles projects 02:30 IST on 8 Mar 2026 (inside its own
 * spring-forward gap) as 02:30, not 03:30. Jest cannot change its own host
 * zone, so the calls run in a child process with TZ set.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");

function inLosAngeles(script: string): string {
  return execFileSync(TSX, ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "America/Los_Angeles" },
    encoding: "utf8",
  }).trim();
}

// 02:30 IST on Sunday 8 Mar 2026; Los Angeles skips 02:00–03:00 that night.
const FIRST = "2026-03-07T21:00:00.000Z";

it("the child really runs on a host with that gap", () => {
  const wall = inLosAngeles(
    `const d = new Date(2026, 2, 8, 2, 30); console.log(d.getHours());`,
  );
  expect(wall).toBe("3");
});

it("a class series and a plan end keep the IST wall time", () => {
  const out = inLosAngeles(`
    import { seriesStartsFrom } from "./lib/booking/class-pattern";
    import { planEndOf } from "./lib/booking/entitlement";
    const first = new Date("${FIRST}");
    console.log(JSON.stringify({
      series: seriesStartsFrom(first, 1, 2, "Asia/Kolkata").map((d) => d.toISOString()),
      planEnd: planEndOf(first, 1, "Asia/Kolkata").toISOString(),
    }));
  `);
  expect(JSON.parse(out)).toEqual({
    series: ["2026-03-07T21:00:00.000Z", "2026-03-14T21:00:00.000Z"],
    planEnd: "2026-04-07T21:00:00.000Z",
  });
}, 30_000);
