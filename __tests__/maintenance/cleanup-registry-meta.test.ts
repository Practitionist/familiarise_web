/**
 * @jest-environment node
 */

/**
 * The registry is the only job list: the console's cards and the admin Run
 * door both derive from it, so a new job cannot be missing from either.
 */

import fs from "node:fs";
import path from "node:path";

import { CLEANUP_JOB_BUILDERS } from "@/lib/cron/cleanup-registry";
import { backgroundJobSchema } from "@/lib/cron/dispatch-background";
import { JOB_CATEGORIES } from "@/lib/cron/job-categories";
import { systemJobCards } from "@/lib/cron/job-catalog";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("cleanup registry metadata", () => {
  const slugs = Object.keys(CLEANUP_JOB_BUILDERS);

  it("gives every slug complete meta and lists every slug on the panel", () => {
    for (const [slug, { meta }] of Object.entries(CLEANUP_JOB_BUILDERS)) {
      expect({ slug, ok: meta.title.length > 0 }).toEqual({ slug, ok: true });
      expect(meta.description.length).toBeGreaterThan(0);
      expect(JOB_CATEGORIES).toContain(meta.category);
      expect(["inline", "after"]).toContain(meta.manualRun);
    }
    expect(systemJobCards().map((card) => card.id)).toEqual(slugs);
  });

  it("lets the Run door accept exactly the registry slugs, background jobs included", () => {
    for (const job of backgroundJobSchema.options) {
      expect(slugs).toContain(job);
    }
    const route = read("app/api/admin/system-jobs/run/route.ts");
    // The door resolves through the registry alone; no second hand list survives.
    expect(route).toContain("Object.hasOwn(CLEANUP_JOB_BUILDERS, jobId)");
    expect(route).not.toMatch(/JOB_FUNCTIONS|BACKGROUND_JOBS|SYSTEM_JOBS/);
    expect(read("components/dashboard/SystemJobsPanel.tsx")).not.toMatch(
      /cleanup-registry|SYSTEM_JOBS/,
    );
  });
});
