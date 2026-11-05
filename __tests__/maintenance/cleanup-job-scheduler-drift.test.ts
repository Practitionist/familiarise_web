/**
 * @jest-environment node
 */

/** The build-time job coverage check, on the real registry and on each violation it must catch. */

import fs from "node:fs";
import path from "node:path";

import { checkJobCoverage, registrySlugs } from "@/lib/cron/job-coverage";

const REGISTRY = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "cron",
  "cleanup-registry.ts",
);
const slugs = registrySlugs(fs.readFileSync(REGISTRY, "utf8"));

const fixture = {
  registrySlugs: ["a", "b", "manual"],
  targets: ["a", "b"],
  manualOnly: { manual: "operator only" },
  requirements: [
    { target: "a", jobName: "a", tier: "paging" },
    { target: "b", jobName: "run-b", tier: "watched" },
  ],
  jobNameOf: (target: string) => (target === "b" ? "run-b" : target),
};

describe("job coverage", () => {
  it("passes on the real registry, schedule and requirements", () => {
    expect(slugs.length).toBeGreaterThan(40);
    expect(checkJobCoverage({ registrySlugs: slugs })).toEqual([]);
    expect(checkJobCoverage(fixture)).toEqual([]);
  });

  it.each([
    [
      "an unscheduled registry job",
      { registrySlugs: [...fixture.registrySlugs, "orphan"] },
      /"orphan" has no ticker target/,
    ],
    [
      "a ticker target with no registry job",
      { targets: [...fixture.targets, "ghost"] },
      /Ticker target "ghost" has no registry job/,
    ],
    [
      "an empty registry parse",
      { registrySlugs: [] },
      /no `\/\/ @cleanup-twin <slug>` markers/,
    ],
    [
      "a MANUAL_ONLY entry with no job",
      { manualOnly: { ...fixture.manualOnly, ghost: "gone" } },
      /MANUAL_ONLY entry "ghost" names no registry job/,
    ],
    [
      "a MANUAL_ONLY entry that is also scheduled",
      { manualOnly: { ...fixture.manualOnly, a: "both" } },
      /"a" is also a ticker target/,
    ],
    [
      "a target without a requirement",
      { requirements: fixture.requirements.slice(0, 1) },
      /"b" has 0 freshness requirements/,
    ],
    [
      "a requirement under a renamed run row",
      {
        requirements: [
          fixture.requirements[0],
          { target: "b", jobName: "old-b", tier: "watched" },
        ],
      },
      /watches "old-b", but the target writes run rows as "run-b"/,
    ],
    [
      "a requirement for a dead target",
      {
        requirements: [
          ...fixture.requirements,
          { target: "gone", jobName: "gone", tier: "paging" },
        ],
      },
      /names "gone", which is not a ticker target/,
    ],
    [
      "a requirement without a tier",
      {
        requirements: [
          fixture.requirements[0],
          { target: "b", jobName: "run-b", tier: "" },
        ],
      },
      /has tier ""/,
    ],
  ])("catches %s", (_case, override, message) => {
    const violations = checkJobCoverage({ ...fixture, ...override });
    expect(violations).toEqual(
      expect.arrayContaining([expect.stringMatching(message)]),
    );
  });
});
