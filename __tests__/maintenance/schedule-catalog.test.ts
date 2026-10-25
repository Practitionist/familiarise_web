/** @jest-environment node */

import {
  JOB_SCHEDULES,
  TARGETS,
  scheduleFor,
  targetRequest,
  dueTargets,
  MAX_TARGETS_PER_TICK,
} from "@/lib/cron/schedule";

describe("shared capability schedule catalog", () => {
  it("dispatches one background copy every 15 minutes and preserves the ten-target cap for every tick of a week", () => {
    const counts = new Map<string, number>();
    const start = Date.UTC(2027, 0, 1);
    for (let tick = 0; tick < 7 * 24 * 12; tick++) {
      const due = dueTargets(new Date(start + tick * 5 * 60_000));
      expect(due.length).toBeLessThanOrEqual(MAX_TARGETS_PER_TICK);
      for (const name of due) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect(counts.get("transfer-recordings")).toBe(7 * 96);
    expect(counts.get("stream-control-plane-drift")).toBe(7);
    expect(counts.get("reconcile-stream-memberships")).toBe(7 * 3);
    expect(counts.get("reconcile-ledgers")).toBeGreaterThan(0);
    expect(targetRequest("https://site.test", "transfer-recordings").url).toBe(
      "https://site.test/.netlify/functions/recording-transfer-background",
    );
    expect(scheduleFor("transfer-recordings")?.backgroundFunction).toBe(
      "recording-transfer-background",
    );
  });
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

  it("preserves the hourly document purge request bounds and phase", () => {
    expect(scheduleFor("purge-deleted-documents")).toMatchObject({
      everyMinutes: 60,
      offsetMinutes: 35,
      limit: 100,
      timeoutMs: 20_000,
      window: null,
    });
    const day = Date.UTC(2026, 9, 24);
    const dueMinutes = Array.from(
      { length: 288 },
      (_, tick) => tick * 5,
    ).filter((minute) =>
      dueTargets(new Date(day + minute * 60_000)).includes(
        "purge-deleted-documents",
      ),
    );
    expect(dueMinutes).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour * 60 + 35),
    );
    expect(
      targetRequest("https://site.test", "purge-deleted-documents"),
    ).toEqual({
      url: "https://site.test/api/cleanup/purge-deleted-documents?limit=100",
      timeoutMs: 20_000,
    });
  });

  it("keeps calendar-gated jobs out of off-window dispatch", () => {
    const outside = new Date("2026-10-22T22:55:00.000Z");
    const inside = new Date("2026-10-22T06:55:00.000Z");
    expect(scheduleFor("reconcile-gateway-settlements")?.window).toMatchObject({
      startMinuteUtc: 390,
      windowMinutes: 360,
    });
    expect(dueTargets(outside)).not.toContain("reconcile-gateway-settlements");
    expect(dueTargets(inside)).toContain("reconcile-gateway-settlements");
  });
});
