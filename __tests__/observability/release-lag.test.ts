/** @jest-environment node */
import {
  readReleaseLag,
  releaseLagVerdict,
} from "@/lib/observability/release-lag";

const now = new Date("2026-11-10T03:50:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const verdict = (over: Partial<Parameters<typeof releaseLagVerdict>[0]>) =>
  releaseLagVerdict({
    buildSha: "abc",
    commitsBehind: 2,
    commitsListed: 2,
    commitDates: [daysAgo(2), daysAgo(1)],
    files: ["docs/x.md"],
    scheduleChangeAt: null,
    now,
    ...over,
  });

describe("release lag thresholds", () => {
  it.each([
    ["a two-day-old merge", {}, false],
    ["any merge older than 7 days", { commitDates: [daysAgo(8)] }, true],
    [
      "a schedule change older than 3 days",
      { commitDates: [daysAgo(4)], scheduleChangeAt: daysAgo(4) },
      true,
    ],
    [
      "a 2-day schedule change behind a 6-day merge",
      { commitDates: [daysAgo(6)], scheduleChangeAt: daysAgo(2) },
      false,
    ],
    ["a cut commit list", { commitsBehind: 300, commitsListed: 250 }, true],
  ])("%s", (_case, over, overdue) => {
    expect(verdict(over)).toMatchObject({ status: "known", overdue });
  });

  it("treats a cut file list as touching every watched area", () => {
    const files = Array.from({ length: 300 }, (_, i) => `docs/${i}.md`);
    expect(verdict({ files })).toMatchObject({
      truncated: true,
      touches: [
        "lib/cron/schedule.ts",
        "lib/cron/cleanup-registry.ts",
        "netlify/functions/**",
        "prisma/**",
      ],
    });
  });
});

describe("reading release lag", () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();
  const commit = (sha: string, date: Date) => ({
    sha,
    commit: { committer: { date: date.toISOString() } },
  });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    process.env = {
      ...originalEnv,
      BUILD_SHA: "abc",
      GITHUB_RELEASE_LAG_TOKEN: "github_pat_x",
    };
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([
    ["no build SHA", { BUILD_SHA: "" }, /BUILD_SHA not set/],
    ["no token", { GITHUB_RELEASE_LAG_TOKEN: "" }, /TOKEN not configured/],
  ])(
    "is unknown with %s, without calling GitHub",
    async (_case, env, reason) => {
      Object.assign(process.env, env);
      expect(await readReleaseLag(now)).toEqual({
        status: "unknown",
        reason: expect.stringMatching(reason),
        overdue: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a failed read",
      () => json({ message: "Not Found" }, 404),
      "GitHub answered 404",
    ],
    [
      "an unexpected shape",
      () => json({ ahead_by: "many" }),
      "unexpected GitHub response shape",
    ],
  ])("is unknown, never overdue, on %s", async (_case, answer, reason) => {
    fetchMock.mockImplementation(answer);
    expect(await readReleaseLag(now)).toEqual({
      status: "unknown",
      reason,
      overdue: false,
    });
  });

  it("dates a schedule change by its own unreleased commit", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/compare/abc...dev")) {
        return json({
          ahead_by: 2,
          commits: [commit("old", daysAgo(5)), commit("new", daysAgo(1))],
          files: [{ filename: "lib/cron/schedule.ts" }],
        });
      }
      // Newest first: the released commit "prod" is not in the comparison.
      return json(
        url.includes("schedule.ts")
          ? [commit("new", daysAgo(1)), commit("prod", daysAgo(9))]
          : [],
      );
    });
    expect(await readReleaseLag(now)).toMatchObject({
      status: "known",
      commitsBehind: 2,
      oldestUnreleasedAt: daysAgo(5).toISOString(),
      scheduleChangeAt: daysAgo(1).toISOString(),
      touches: ["lib/cron/schedule.ts"],
      overdue: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/Practitionist/familiarise_web/compare/"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer github_pat_x",
        }),
      }),
    );
  });
});
