/**
 * @jest-environment node
 */

/**
 * #E5 — Stream quota metering, and specifically its Upstash command budget.
 *
 * The 500k monthly cap has been hit twice (#1792 at 696k, #1822) and production
 * and every deploy-preview share ONE database, so "does this feature fit" is a
 * question with a number, not a preference. These cases pin both halves:
 *
 *   - the MAU counter costs ONE command per mint in the steady state and THREE
 *     for a user appearing in the 30-day window for the first time. The marker
 *     write and the dedup decision are the SAME `SET NX`, which is what buys
 *     that; a read-then-write would be two commands every time.
 *   - the alarm fires BEFORE the cap, at 60/80/90, and the number an operator
 *     reads is the LOWEST threshold crossed rather than the most extreme.
 *
 * And the honest part: a read failure returns all-null, not zeros.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockSet = jest.fn();
const mockIncr = jest.fn();
const mockExpire = jest.fn();
const mockHset = jest.fn();
const mockHgetall = jest.fn();
const mockGet = jest.fn();

// `lib/stream/usage.ts` reaches Redis through the DEFAULT export (the
// `Redis | MockRedis` union), so the mock has to carry the commands there and
// not only as named exports.
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    set: (...args: unknown[]) => mockSet(...args),
    incr: (...args: unknown[]) => mockIncr(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
    hset: (...args: unknown[]) => mockHset(...args),
    hgetall: (...args: unknown[]) => mockHgetall(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
  set: (...args: unknown[]) => mockSet(...args),
  incr: (...args: unknown[]) => mockIncr(...args),
  expire: (...args: unknown[]) => mockExpire(...args),
  hset: (...args: unknown[]) => mockHset(...args),
  hgetall: (...args: unknown[]) => mockHgetall(...args),
  get: (...args: unknown[]) => mockGet(...args),
}));

import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";
import * as Sentry from "@sentry/nextjs";
import {
  STREAM_MAKER_LIMITS,
  STREAM_USAGE_ALERT_THRESHOLDS,
  noteStreamTokenMint,
  readStreamUsage,
  writeStreamUsageSnapshot,
  resetStreamUsageCacheForTesting,
  alertStreamUsage,
  streamMauMonthKey,
  streamMauMonthTtlSeconds,
} from "../../lib/stream/usage";

const ORIGINAL_ENV = process.env;

// #1829 — the MAU bucket is the calendar month, so every test in this file that
// asserts on a KEY must be told which month it is asserting about. Frozen to a
// mid-month instant: the real clock would make the expected key change on the
// 1st of a month and turn a code change into a test failure with no diff.
const FROZEN_NOW = new Date("2026-09-15T12:00:00.000Z");
const month = streamMauMonthKey(FROZEN_NOW);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
  jest.setSystemTime(FROZEN_NOW);
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
  resetStreamUsageCacheForTesting();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.STREAM_USAGE_METER_ENABLED;
  mockSet.mockResolvedValue("OK");
  mockIncr.mockResolvedValue(1);
  mockExpire.mockResolvedValue(1);
  mockHset.mockResolvedValue(1);
  mockExpire.mockResolvedValue(1);
  mockHgetall.mockResolvedValue(null);
  mockGet.mockResolvedValue(null);
});

afterAll(() => {
  jest.useRealTimers();
  process.env = ORIGINAL_ENV;
});

describe("noteStreamTokenMint — the command budget (#E5)", () => {
  it("costs ONE command for a user already inside the 30-day window", async () => {
    // `SET … NX` returns null when the key already exists, which is both the
    // dedup decision and the marker write. The alternative — a GET then a SET —
    // is two commands on EVERY mint, and mints are the hot path here.
    mockSet.mockResolvedValue(null);

    await noteStreamTokenMint("user-1");

    expect(mockSet).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mockSet.mock.calls[0];
    // #1829 — month-scoped, so the marker that suppresses a double-count
    // expires WITH the count it belongs to.
    expect(key).toBe(`stream:usage:mau:${month}:seen:user-1`);
    expect(value).toBe("1");
    // `px` not `ex`: milliseconds is the form MockRedis also accepts, so the one
    // command a mock-Redis test exercises for real is the same one production
    // runs.
    expect(opts).toEqual({ nx: true, px: expect.any(Number) });
    // And no counter bump for a user we have already counted.
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it("costs THREE commands the first time a user appears in the window", async () => {
    mockSet.mockResolvedValue("OK");

    await noteStreamTokenMint("user-1");

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockIncr).toHaveBeenCalledWith(`stream:usage:mau:${month}:count`);
    expect(mockExpire).toHaveBeenCalledWith(
      `stream:usage:mau:${month}:count`,
      45 * 24 * 60 * 60,
    );
  });

  // #1829 — the reason the counter is month-bucketed at all. A single global
  // counter plus globally-expiring markers is monotonically non-decreasing: a
  // user counted today cannot be uncounted, so the 60/80/90% alarms, once
  // crossed, can never clear — and an operator trained on an alarm that
  // structurally cannot reset stops reading it.
  it("counts each user once PER MONTH, and starts again in the next", async () => {
    mockSet.mockResolvedValue("OK");

    await noteStreamTokenMint("user-1");
    const september = mockIncr.mock.calls[0][0];
    expect(september).toBe(`stream:usage:mau:${month}:count`);

    // The same user, next month. A month-scoped marker has expired with its
    // month, so this is a first appearance again and lands in a different key.
    const nextMonth = streamMauMonthKey(
      new Date(Date.UTC(2026, Number(month.slice(4)) - 1 + 1, 15)),
    );
    expect(nextMonth).not.toBe(month);

    mockIncr.mockClear();
    jest.setSystemTime(new Date(Date.UTC(2026, Number(month.slice(4)), 15)));
    await noteStreamTokenMint("user-1");

    expect(mockSet.mock.calls[1][0]).toBe(
      `stream:usage:mau:${nextMonth}:seen:user-1`,
    );
    expect(mockIncr).toHaveBeenCalledWith(
      `stream:usage:mau:${nextMonth}:count`,
    );
  });

  it("expires the marker just past month end, so a 23:59 mint stays deduped", () => {
    // A user who connects in the last minute of the month must remain counted
    // ONCE. A marker expiring exactly at the boundary would let a second mint
    // milliseconds later claim fresh and inflate the count it is already in.
    const lastMinute = new Date("2026-09-30T23:59:00.000Z");
    const ttl = streamMauMonthTtlSeconds(lastMinute);

    // 60s to midnight, plus the slack day.
    expect(ttl).toBe(60 + 24 * 60 * 60);
    // And it must outlast the month it names, never the reverse.
    expect(streamMauMonthKey(lastMinute)).toBe("202609");
  });

  it("buckets on the UTC month boundary, not a local one", () => {
    // The hazard a local-time key creates. In UTC-5, local midnight falls at
    // 05:00Z, so a LOCAL key would file 04:59:59Z under September and
    // 05:00:01Z under October — one user, two mints, two months, counted twice.
    //
    // A UTC key is immune because its boundary is the same instant everywhere,
    // so both of these land in October, deduped against each other.
    const justBeforeLocalMidnight = new Date("2026-10-01T04:59:59.000Z");
    const justAfterLocalMidnight = new Date("2026-10-01T05:00:01.000Z");

    expect(streamMauMonthKey(justBeforeLocalMidnight)).toBe("202610");
    expect(streamMauMonthKey(justAfterLocalMidnight)).toBe("202610");

    // And the real boundary does split, on UTC midnight.
    expect(streamMauMonthKey(new Date("2026-09-30T23:59:59.000Z"))).toBe(
      "202609",
    );
    expect(streamMauMonthKey(new Date("2026-10-01T00:00:00.000Z"))).toBe(
      "202610",
    );
  });

  it("handles the December-to-January rollover", () => {
    expect(streamMauMonthKey(new Date("2026-12-31T23:59:59.000Z"))).toBe(
      "202612",
    );
    expect(streamMauMonthKey(new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "202701",
    );
  });

  it('treats a claim reply that is not "OK" as NOT claimed', async () => {
    // Anything other than the literal means the claim did not happen, and
    // guessing would double-count — the one error direction that matters for a
    // ceiling alarm.
    mockSet.mockResolvedValue(undefined);

    await noteStreamTokenMint("user-1");

    expect(mockIncr).not.toHaveBeenCalled();
  });

  it("NEVER throws — a meter that can fail a login is worse than no meter", async () => {
    mockSet.mockRejectedValue(new Error("ERR max requests limit exceeded"));

    await expect(noteStreamTokenMint("user-1")).resolves.toBeUndefined();
  });

  it("is switchable off, for the case where 8% of the cap is not worth the number", async () => {
    process.env.STREAM_USAGE_METER_ENABLED = "false";

    await noteStreamTokenMint("user-1");

    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("writeStreamUsageSnapshot — two commands per NIGHT (#E5)", () => {
  it("writes one hash and one TTL, and nothing else", async () => {
    await writeStreamUsageSnapshot({
      mau: 42,
      participantMinutes: 1234,
      peakConcurrency: 7,
      computedAt: "2026-09-29T04:20:00.000Z",
      estimated: false,
    });

    expect(mockHset).toHaveBeenCalledTimes(1);
    expect(mockHset).toHaveBeenCalledWith("stream:usage:snapshot", {
      mau: "42",
      // #1829 — stamped from `computedAt`, not "now". The job can run at 00:05
      // for the day just ended, in which case stamping by wall clock would file
      // yesterday's figure under tomorrow's month and the reader would discard
      // the number it is supposed to fall back to.
      mauMonth: "202609",
      participantMinutes: "1234",
      peakConcurrency: "7",
      computedAt: "2026-09-29T04:20:00.000Z",
      estimated: "false",
    });
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockIncr).not.toHaveBeenCalled();
  });
});

// #1829 — the read side of the month rollover. A snapshot is a valid record of
// what we were billed LAST month and a misleading number for what we are about
// to be billed, and the two failure directions are not symmetric: reporting too
// high trips the alarm on day one, and an operator who has learned to dismiss
// that alarm misses the real one later in the month.
describe("readStreamUsage — the month boundary (#1829)", () => {
  it("does NOT serve last month's snapshot figure as this month's usage", async () => {
    mockHgetall.mockResolvedValue({
      mau: "1800",
      mauMonth: "202608", // August, read on 15 September
      participantMinutes: "1234",
      peakConcurrency: "7",
      computedAt: "2026-08-31T23:59:00.000Z",
      estimated: "false",
    });
    mockGet.mockResolvedValue(null); // no mints yet this month

    const report = await readStreamUsage();

    // Zero, not 1800. The month genuinely has no counted users yet.
    expect(report.snapshot?.mau).toBe(0);
    expect(report.meters.mau?.used).toBe(0);
    // And with 0 of 2000, no threshold is crossed: a fresh month is quiet.
    expect(report.worstAlert).toBeNull();
  });

  it("DOES fall back to the snapshot when it is the SAME month", async () => {
    // The fallback still earns its place: a missed night, a throttled Action, or
    // a cold counter must not read as zero spend.
    mockHgetall.mockResolvedValue({
      mau: "1800",
      mauMonth: month,
      participantMinutes: "1234",
      peakConcurrency: "7",
      computedAt: `${month.slice(0, 4)}-${month.slice(4)}-14T04:20:00.000Z`,
      estimated: "false",
    });
    mockGet.mockResolvedValue(null);

    const report = await readStreamUsage();

    expect(report.snapshot?.mau).toBe(1800);
    // 1800/2000 is 90%, the top threshold — which is the point: a same-month
    // snapshot at that height is exactly the alarm an operator must see.
    expect(report.meters.mau?.pct).toBeCloseTo(0.9);
    expect(report.meters.mau?.alert).toBe(0.9);
  });

  it("prefers the live counter over a same-month snapshot", async () => {
    mockHgetall.mockResolvedValue({
      mau: "1800",
      mauMonth: month,
      participantMinutes: "1234",
      peakConcurrency: "7",
      computedAt: "2026-09-14T04:20:00.000Z",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1850"); // exact to the last mint

    const report = await readStreamUsage();

    expect(report.snapshot?.mau).toBe(1850);
  });

  it("reports 0 rather than a stale figure when an OLD snapshot predates the stamp", async () => {
    // A snapshot written before `mauMonth` existed carries no month at all.
    // Treating an unstamped figure as current is the bug; treating it as absent
    // is the safe direction, so the month reads zero until a real mint lands.
    mockHgetall.mockResolvedValue({
      mau: "1800",
      participantMinutes: "1234",
      peakConcurrency: "7",
      computedAt: "2026-08-31T23:59:00.000Z",
      estimated: "false",
    });
    mockGet.mockResolvedValue(null);

    const report = await readStreamUsage();

    expect(report.snapshot?.mau).toBe(0);
  });
});

describe("readStreamUsage — alarm BEFORE the cap (#E5)", () => {
  it("folds the figures against the Maker caps", async () => {
    mockHgetall.mockResolvedValue({
      mau: "1000",
      participantMinutes: "166500",
      peakConcurrency: "9",
      computedAt: "2026-09-29T04:20:00.000Z",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1000");

    const report = await readStreamUsage();

    // Exactly 50% of each: no threshold crossed, nothing to do. The alarm is not
    // a warning about approaching a number.
    expect(report.meters.mau).toEqual({
      used: 1000,
      cap: STREAM_MAKER_LIMITS.mau,
      pct: 0.5,
      alert: null,
    });
    expect(report.meters.participantMinutes!.pct).toBeCloseTo(0.5, 3);
    expect(report.worstAlert).toBeNull();
  });

  it.each([
    [0.6, 1200],
    [0.8, 1600],
    [0.9, 1800],
  ])("crosses the %s threshold at %s MAU", async (threshold, mau) => {
    mockHgetall.mockResolvedValue({
      mau: String(mau),
      participantMinutes: "0",
      peakConcurrency: "0",
      computedAt: "2026-09-29T04:20:00.000Z",
      estimated: "false",
    });
    mockGet.mockResolvedValue(String(mau));

    const report = await readStreamUsage();

    expect(report.meters.mau!.alert).toBe(threshold);
    expect(report.worstAlert).toBe(threshold);
  });

  it("reports the HIGHEST crossed level, so an escalation is never swallowed", async () => {
    // 85% has crossed both 60 and 80. Reporting 60 would mean the 80% event is
    // suppressed by the 60% one for the rest of the window — which is exactly
    // the moment an operator most needs to hear. The level named in a 3am alert
    // is the one they are actually past.
    mockHgetall.mockResolvedValue({
      mau: "1700",
      participantMinutes: "0",
      peakConcurrency: "0",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1700");

    const report = await readStreamUsage();

    expect(report.meters.mau!.alert).toBe(0.8);
    expect(report.worstAlert).toBe(0.8);
  });

  it("reports the highest level across METERS, so the alert names the urgent one", async () => {
    mockHgetall.mockResolvedValue({
      mau: "100",
      participantMinutes: "333000",
      peakConcurrency: "40",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("100");

    const report = await readStreamUsage();

    // Chat is nowhere near its cap and video is exactly at it. The whole point
    // of a worst-of across meters: one meter healthy does not make the readout
    // healthy.
    expect(report.meters.mau!.alert).toBeNull();
    expect(report.meters.participantMinutes!.alert).toBe(0.9);
    expect(report.worstAlert).toBe(0.9);
  });

  it("carries the LIVE MAU counter over the snapshot's stored copy", async () => {
    // The snapshot can be up to 24 h old; the counter is exact to the last
    // mint. A monthly figure that lags by a day is a figure you cannot act on
    // in the last week of the month.
    mockHgetall.mockResolvedValue({
      mau: "100",
      participantMinutes: "10",
      peakConcurrency: "1",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1750");

    const report = await readStreamUsage();

    expect(report.snapshot!.mau).toBe(1750);
    expect(report.snapshot!.participantMinutes).toBe(10);
  });

  it("reports the unmetered feed-API cap rather than implying full coverage", async () => {
    mockHgetall.mockResolvedValue(null);
    mockGet.mockResolvedValue(null);

    const report = await readStreamUsage();

    expect(report.unmetered).toEqual(["feedApiCalls"]);
    expect(report.meters.feedApiCalls).toBeNull();
  });

  it("returns NULLS, never zeros, when the read fails", async () => {
    // Zeros would read as "we are nowhere near the cap", which is the most
    // dangerous possible answer to give a ceiling monitor. Silence is the only
    // honest failure.
    mockHgetall.mockRejectedValue(new Error("ERR max requests limit exceeded"));
    mockGet.mockRejectedValue(new Error("ERR max requests limit exceeded"));

    const report = await readStreamUsage();

    expect(report.snapshot).toBeNull();
    expect(report.meters).toEqual({
      mau: null,
      participantMinutes: null,
      feedApiCalls: null,
    });
    expect(report.worstAlert).toBeNull();
  });

  it("caches the read per instance so a polled /api/health cannot multiply the cost", async () => {
    mockHgetall.mockResolvedValue(null);
    mockGet.mockResolvedValue("10");

    await readStreamUsage();
    await readStreamUsage();
    await readStreamUsage();

    expect(mockHgetall).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("thresholds are the three documented levels, all below the cap", () => {
    // At the cap the product is ALREADY refusing new connections, so a threshold
    // at 100% would be a post-mortem rather than a warning.
    expect([...STREAM_USAGE_ALERT_THRESHOLDS]).toEqual([0.6, 0.8, 0.9]);
    expect(Math.max(...STREAM_USAGE_ALERT_THRESHOLDS)).toBeLessThan(1);
  });
});

describe("alertStreamUsage (#E5)", () => {
  it("says a Maker cap is a HARD PAUSE, so the upgrade is before the number", async () => {
    // The write is stubbed at the Redis boundary, so the read has to be given
    // the hash it would have produced — which is also a useful statement that
    // the whole feature round-trips through ONE hash.
    mockHgetall.mockResolvedValue({
      mau: "1300",
      participantMinutes: "0",
      peakConcurrency: "0",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1300");
    await writeStreamUsageSnapshot({
      mau: 1300,
      participantMinutes: 0,
      peakConcurrency: 0,
      computedAt: "x",
      estimated: false,
    });
    // The write drops the read cache, so the very next read is the new snapshot
    // — a /api/health poll that landed a minute before the nightly run must not
    // keep serving last night's figures on a MONTHLY budget.
    const report = await readStreamUsage();
    expect(report.worstAlert).toBe(0.6);

    alertStreamUsage(report);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const message = (Sentry.captureException as jest.Mock).mock.calls[0][0]
      .message as string;
    expect(message).toContain("hard pause");
    expect(message).toContain("before this number, not after it");
  });

  it("says nothing when nothing is crossed", async () => {
    mockHgetall.mockResolvedValue({
      mau: "1",
      participantMinutes: "1",
      peakConcurrency: "1",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1");
    const report = await readStreamUsage();

    alertStreamUsage(report);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("throttles per LEVEL, so an escalation is never swallowed by the one below", async () => {
    // A budget that crosses 60% and then sits there for three weeks should be
    // one warning, not one per night — but 80% must still produce its own event,
    // or the escalation is exactly the moment nobody hears about.
    mockHgetall.mockResolvedValue({
      mau: "1200",
      participantMinutes: "0",
      peakConcurrency: "0",
      computedAt: "x",
      estimated: "false",
    });
    mockGet.mockResolvedValue("1200");
    alertStreamUsage(await readStreamUsage());
    alertStreamUsage(await readStreamUsage());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // The read is cached per instance, so the escalation needs a fresh read to
    // be seen at all — which is itself part of what the cache is for.
    resetStreamUsageCacheForTesting();
    mockGet.mockResolvedValue("1700");
    mockHgetall.mockResolvedValue({
      mau: "1700",
      participantMinutes: "0",
      peakConcurrency: "0",
      computedAt: "x",
      estimated: "false",
    });
    alertStreamUsage(await readStreamUsage());
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });
});
