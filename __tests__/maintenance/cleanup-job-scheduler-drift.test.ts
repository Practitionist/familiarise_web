/**
 * @jest-environment node
 */

/**
 * Every `/api/cleanup/[job]` slug must have a scheduler: a Netlify ticker
 * target, a step in a `cron-*.yml` workflow, or an explicit `MANUAL_ONLY` entry.
 * Sources are read as text so the check needs neither Prisma nor Redis.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

/** Slug plus the `job:` name its entry runs under, which workflows may use instead. */
function registryJobs(): { slug: string; names: string[] }[] {
  const src = fs.readFileSync(
    path.join(ROOT, "lib", "cron", "cleanup-registry.ts"),
    "utf8",
  );
  return src
    .split(/\/\/ @cleanup-twin /)
    .slice(1)
    .map((block) => {
      const slug = block.match(/^([a-z0-9-]+)/)![1];
      const job = block.match(/job: "([a-z0-9-]+)"/)?.[1];
      return { slug, names: job ? [slug, job] : [slug] };
    });
}

function manualOnly(): string[] {
  const src = fs.readFileSync(
    path.join(ROOT, "lib", "cron", "cleanup-registry.ts"),
    "utf8",
  );
  const body = src.match(/export const MANUAL_ONLY[^=]*=\s*\{([\s\S]*?)\n\};/);
  return [...(body?.[1] ?? "").matchAll(/^\s*"([a-z0-9-]+)":/gm)].map(
    (m) => m[1],
  );
}

function tickerTargets(): Set<string> {
  const src = fs.readFileSync(
    path.join(ROOT, "netlify", "functions", "cron-tick.mts"),
    "utf8",
  );
  const body = src.match(/const TARGETS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  const code = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return new Set([...code.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
}

function workflowText(): string {
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => /^cron-.*\.yml$/.test(f))
    .map((f) => fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"))
    .join("\n")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("cleanup job schedulers", () => {
  const jobs = registryJobs();
  const keys = jobs.map((j) => j.slug);
  const targets = tickerTargets();
  const workflows = workflowText();
  const manual = manualOnly();

  it("reads a non-trivial registry", () => {
    expect(keys.length).toBeGreaterThan(40);
    expect(targets.size).toBeGreaterThan(10);
  });

  it("gives every registry job a ticker target, a workflow step, or a MANUAL_ONLY reason", () => {
    const unscheduled = jobs
      .filter(({ slug, names }) => {
        if (targets.has(slug) || manual.includes(slug)) return false;
        return !names.some((n) =>
          new RegExp(
            `(id:\\s*${n}\\s*$)|(/${n}\\.ts)|(api/cleanup/${n}\\b)`,
            "m",
          ).test(workflows),
        );
      })
      .map((j) => j.slug);
    expect(unscheduled).toEqual([]);
  });

  it("keeps MANUAL_ONLY entries real and unscheduled", () => {
    for (const slug of manual) {
      expect(keys).toContain(slug);
      expect(targets.has(slug)).toBe(false);
    }
  });
});
