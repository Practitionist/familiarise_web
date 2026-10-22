/** @jest-environment node */

import {
  JOB_SCHEDULES,
  TARGETS,
  scheduleFor,
  targetRequest,
  dueTargets,
} from "@/lib/cron/schedule";

describe("shared capability schedule catalog", () => {
  it("exposes one effective descriptor per scheduled capability", () => {
    expect(JOB_SCHEDULES.map((job) => job.name)).toEqual([...TARGETS]);
    expect(new Set(JOB_SCHEDULES.map((job) => job.name)).size).toBe(
      TARGETS.length,
    );
    expect(scheduleFor("not-a-real-capability")).toBeUndefined();
    for (const job of JOB_SCHEDULES) {
      const request = targetRequest("https://site.test", job.name);
      const url = new URL(request.url);
      expect(request.timeoutMs).toBe(job.timeoutMs);
      expect(url.searchParams.get("limit")).toBe(
        job.limit === null ? null : String(job.limit),
      );
      expect(job.everyMinutes).toBeGreaterThan(0);
      expect(scheduleFor(job.name)).toEqual(job);
    }
  });

  it("keeps calendar-gated jobs out of off-window dispatch", () => {
    const outside = new Date("2026-10-22T22:55:00.000Z");
    const inside = new Date("2026-10-22T03:55:00.000Z");
    expect(scheduleFor("reconcile-ledgers")?.window).toMatchObject({
      startMinuteUtc: 180,
      windowMinutes: 60,
    });
    expect(dueTargets(outside)).not.toContain("reconcile-ledgers");
    expect(dueTargets(inside)).toContain("reconcile-ledgers");
  });
});
