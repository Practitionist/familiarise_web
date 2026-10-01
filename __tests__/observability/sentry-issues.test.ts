/**
 * @jest-environment node
 *
 * `lib/observability/sentry-issues` — the back-office triage lookup.
 *
 * The contract that matters is the degradation one. This function sits inside
 * `readUser360`, a page an on-call support agent opens DURING an incident. If
 * Sentry is slow, rate-limited, misconfigured, or simply absent — and right
 * now it is absent, because `SENTRY_API_TOKEN` has never been set — the page
 * must still render the person's bookings and payments. Every failure path
 * therefore resolves to `{ configured: false }` and never rejects.
 */

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.SENTRY_API_TOKEN;
});

function issue(over: Record<string, unknown> = {}) {
  return {
    id: "12345",
    shortId: "FAMILIARISE_WEB-5Y",
    title: "UpstashError: max requests limit exceeded",
    culprit: "POST /api/cleanup/dispatch-outbound-webhooks",
    level: "error",
    lastSeen: "2026-09-21T12:28:21.000Z",
    ...over,
  };
}

const load = async () => {
  const mod = await import("../../lib/observability/sentry-issues");
  return mod.findUserIssues;
};

describe("malformed configuration", () => {
  /**
   * `SENTRY_API_BASE` is read at module load, so the env var must be set
   * before the first import — an earlier version of this test set it inside
   * the body and passed for the wrong reason, on the valid default.
   */
  it("a scheme-less SENTRY_API_URL resolves instead of rejecting", async () => {
    jest.resetModules();
    process.env.SENTRY_API_TOKEN = "sntrys_test";
    process.env.SENTRY_API_URL = "us.sentry.io"; // no scheme: `new URL` throws
    try {
      const { findUserIssues } =
        await import("../../lib/observability/sentry-issues");
      await expect(findUserIssues({ userId: "usr_x" })).resolves.toEqual({
        configured: false,
        issues: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.SENTRY_API_URL;
      jest.resetModules();
    }
  });

  it("a base that already carries /api/0 is not silently accepted twice", async () => {
    // The documented default is the bare host precisely because the code
    // appends /api/0 itself. This records the shape so a future doc edit that
    // puts it back in the default is caught rather than shipped as a 404.
    jest.resetModules();
    process.env.SENTRY_API_TOKEN = "sntrys_test";
    process.env.SENTRY_API_URL = "https://us.sentry.io";
    try {
      const { findUserIssues } =
        await import("../../lib/observability/sentry-issues");
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });
      await findUserIssues({ userId: "usr_x" });
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "/api/0/organizations/",
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(
        "/api/0/api/0/",
      );
    } finally {
      delete process.env.SENTRY_API_URL;
      jest.resetModules();
    }
  });
});

describe("findUserIssues", () => {
  it("returns not-configured and makes no network call without a token", async () => {
    const findUserIssues = await load();
    const res = await findUserIssues({ userId: "usr_1" });

    expect(res).toEqual({ configured: false, issues: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries by the indexed user.id field, scoped to this project", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({ ok: true, json: async () => [issue()] });
    const findUserIssues = await load();
    await findUserIssues({ userId: "usr_123" });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/organizations/practitionist/issues/");
    expect(url.searchParams.get("query")).toBe(
      'user.id:"usr_123" is:unresolved',
    );
    expect(url.searchParams.get("project")).toBe("familiarise_web");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("reduces an issue to the fields a support agent can act on", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({ ok: true, json: async () => [issue()] });
    const findUserIssues = await load();

    const res = await findUserIssues({ userId: "usr_123" });
    expect(res.configured).toBe(true);
    expect(res.issues).toHaveLength(1);
    expect(res.issues?.[0]).toEqual({
      shortId: "FAMILIARISE_WEB-5Y",
      title: "UpstashError: max requests limit exceeded",
      culprit: "POST /api/cleanup/dispatch-outbound-webhooks",
      level: "error",
      lastSeen: "2026-09-21T12:28:21.000Z",
      permalink: "https://practitionist.sentry.io/issues/12345/",
    });
  });

  it("prefers the permalink Sentry returns over a reconstructed one", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        issue({
          permalink: "https://us.sentry.io/pip/practitionist/issues/12345/",
        }),
      ],
    });
    const findUserIssues = await load();
    const res = await findUserIssues({ userId: "usr_1" });
    expect(res.issues?.[0]?.permalink).toBe(
      "https://us.sentry.io/pip/practitionist/issues/12345/",
    );
  });

  it("falls back to a constructed permalink when Sentry omits one", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({ ok: true, json: async () => [issue()] });
    const findUserIssues = await load();
    const res = await findUserIssues({ userId: "usr_1" });
    expect(res.issues?.[0]?.permalink).toBe(
      "https://practitionist.sentry.io/issues/12345/",
    );
  });

  it("drops entries missing an id or a title instead of rendering blanks", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        issue(),
        { shortId: "X-1" },
        { title: "no id" },
        null,
        "nope",
      ],
    });
    const findUserIssues = await load();

    const res = await findUserIssues({ userId: "usr_1" });
    expect(res.issues).toHaveLength(1);
    expect(res.issues?.[0]?.shortId).toBe("FAMILIARISE_WEB-5Y");
  });

  it("degrades on 401/403 (wrong or under-scoped token)", async () => {
    process.env.SENTRY_API_TOKEN = "stale";
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const findUserIssues = await load();

    await expect(findUserIssues({ userId: "usr_1" })).resolves.toEqual({
      configured: false,
      issues: null,
    });
  });

  it("degrades on 429 (rate limited) rather than failing the page", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    const findUserIssues = await load();

    await expect(findUserIssues({ userId: "usr_1" })).resolves.toEqual({
      configured: false,
      issues: null,
    });
  });

  it("degrades on a transport failure", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const findUserIssues = await load();

    await expect(findUserIssues({ userId: "usr_1" })).resolves.toEqual({
      configured: false,
      issues: null,
    });
  });

  it("gives up on a request that never settles, rather than holding the page open", async () => {
    // The lookup sits inside a back-office page render. A hung socket must
    // cost REQUEST_TIMEOUT_MS and then degrade, not pin the request until
    // Netlify's own limit kills it.
    process.env.SENTRY_API_TOKEN = "tok";
    jest.useFakeTimers();
    try {
      // Never resolves on its own; only the AbortSignal ends it.
      fetchMock.mockImplementation(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      const findUserIssues = await load();

      const pending = findUserIssues({ userId: "usr_1" });
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toEqual({
        configured: false,
        issues: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("degrades when the body is not a list", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ detail: "nope" }),
    });
    const findUserIssues = await load();

    await expect(findUserIssues({ userId: "usr_1" })).resolves.toEqual({
      configured: false,
      issues: null,
    });
  });

  it("clamps the limit into a sane range", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const findUserIssues = await load();

    await findUserIssues({ userId: "usr_1", limit: 9_999 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=25");
  });

  it("never calls out for an empty user id", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    const findUserIssues = await load();
    await findUserIssues({ userId: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
