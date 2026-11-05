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
import { ITEM_KEYS } from "@/lib/cron/run-outcome";

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

  describe("run item counts", () => {
    // Entries with no `summarize` whose core result itself carries a recognised item key.
    const RAW_KEYED = [
      "prune-system-events",
      "advance-program-cycles",
      "auto-renew-contracts",
      "expire-contracts",
      "heal-consumer-invoices",
      "irp-uploader",
      "reconcile-org-invoice-payments",
      "reconcile-sessions",
      "timeout-member-overages",
      "wallet-low-balance",
    ];
    const registry = read("lib/cron/cleanup-registry.ts");
    const blocks = new Map(
      registry
        .split(/ {2}\/\/ @cleanup-twin (\S+)\n/)
        .slice(1)
        .reduce<Array<[string, string]>>((acc, part, i, all) => {
          if (i % 2 === 0) acc.push([part, all[i + 1]]);
          return acc;
        }, []),
    );
    const hasItemKey = (text: string) =>
      ITEM_KEYS.some((key) => new RegExp(`\\b${key}:`).test(text));

    it("gives every job a recognised item key or an items hook", () => {
      const missing = [...blocks]
        .filter(([slug, block]) => {
          if (block.includes("items:")) return false;
          if (block.includes("dispatchBackgroundJob(")) return false;
          if (RAW_KEYED.includes(slug)) return false;
          const summarize = /summarize:[\s\S]*?failureMessage/.exec(block);
          return !(summarize && hasItemKey(summarize[0]));
        })
        .map(([slug]) => slug);
      expect(missing).toEqual([]);
    });

    it("keeps the raw-keyed list to entries with neither summarize nor items", () => {
      expect(blocks.size).toBe(slugs.length);
      for (const slug of RAW_KEYED) {
        const block = blocks.get(slug) ?? "";
        expect(block).not.toMatch(/summarize:|items:/);
      }
    });
  });
});
