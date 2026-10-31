/**
 * @jest-environment node
 *
 * The canary reads `stats_v2` grouped by outcome and reason; a quota or
 * rate-limit rejection, or an unreadable answer, is unhealthy.
 */

import {
  checkSentryIngest,
  isQuotaExhausted,
  judgeStats,
  sentryStatsUrl,
} from "../../lib/observability/ingest-canary";

const group = (outcome: string, reason: string, n: number) => ({
  by: { outcome, reason },
  totals: { "sum(quantity)": n },
  series: { "sum(quantity)": [n] },
});

describe("sentry-ingest-canary stats verdict", () => {
  it("judges quota rejections, throttles, client discards and bad reads", async () => {
    const quota = judgeStats({
      groups: [
        group("accepted", "none", 12),
        group("client_discard", "before_send", 40),
        group("rate_limited", "error_usage_exceeded", 7),
      ],
    });
    expect(quota).toMatchObject({ verdict: "rejecting", accepted: 12 });
    expect(quota.rejections).toEqual([
      { outcome: "rate_limited", reason: "error_usage_exceeded", count: 7 },
    ]);
    expect(isQuotaExhausted(quota)).toBe(true);

    const throttle = judgeStats({
      groups: [group("rate_limited", "smart_rate_limit", 3)],
    });
    expect(throttle.verdict).toBe("rejecting");
    expect(isQuotaExhausted(throttle)).toBe(false);

    expect(
      judgeStats({ groups: [group("client_discard", "network_error", 9)] })
        .verdict,
    ).toBe("accepted");
    expect(judgeStats({ data: [] }).verdict).toBe("stats-unreadable");

    const fetch403 = jest.fn(async () => new Response("{}", { status: 403 }));
    await expect(
      checkSentryIngest("tok", fetch403 as unknown as typeof fetch),
    ).resolves.toMatchObject({
      verdict: "stats-unreadable",
      detail: "stats_v2 answered 403",
    });
    expect(sentryStatsUrl()).toContain(
      "stats_v2/?category=error&field=sum%28quantity%29&statsPeriod=1d&groupBy=outcome&groupBy=reason",
    );
  });
});
