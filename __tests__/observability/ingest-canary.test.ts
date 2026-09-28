/**
 * @jest-environment node
 *
 * `lib/observability/ingest-canary` — the check that would have caught the
 * six-day silent outage.
 *
 * The bug these pin down is a misreading, not a crash: Sentry answers `200 {}`
 * for session and transaction items while answering error items with `429
 * … organization:error_usage_exceeded`. A canary that only checks "did the
 * POST return 2xx" sees green for the whole failure window. So the verdict
 * has to come from the status AND the rate-limit header AND the body.
 */

import {
  buildErrorEnvelope,
  describeIngest,
  envelopeEndpointFromDsn,
  isIngestHealthy,
  probeSentryIngest,
  type IngestProbeResult,
} from "../../lib/observability/ingest-canary";

// Synthetic DSN. Shape only: a fixture must never carry the real DSN public
// key or the live org/project ids, because a test file is a committed file.
const DSN =
  "https://0123456789abcdef0123456789abcdef@o0123456789abcdef.ingest.us.sentry.io/0123456789abcdef";

function fakeResponse(init: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}) {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: (k: string) => init.headers?.[k] ?? null },
    text: async () => init.body ?? "",
  } as unknown as Response;
}

const send = (res: Response) => async () => res;

const run = (res: Response) =>
  probeSentryIngest({ send: send(res), dsn: DSN, eventId: "a".repeat(32) });

describe("envelopeEndpointFromDsn", () => {
  it("derives the endpoint and public key from the DSN", () => {
    const out = envelopeEndpointFromDsn(DSN);
    expect(out?.publicKey).toBe("0123456789abcdef0123456789abcdef");
    expect(out?.url).toContain("o0123456789abcdef.ingest.us.sentry.io");
    expect(out?.url).toContain("/api/0123456789abcdef/envelope/");
  });

  // Without sentry_key the ingest endpoint rejects with 401, so a canary that
  // omitted it would report "auth broken" forever.
  it("includes the public key, which ingest requires", () => {
    expect(envelopeEndpointFromDsn(DSN)?.url).toContain(
      "sentry_key=0123456789abcdef0123456789abcdef",
    );
  });

  // The DSN host already carries the collector subdomain mid-host
  // (`o<org>.ingest.<region>.sentry.io`). Rewriting it produced
  // `ingest.o<org>.ingest.<region>.sentry.io`, which resolves to nothing —
  // and the failure mode is a bare DNS error, not an HTTP status, so only
  // live testing catches it.
  it("uses the DSN host verbatim, without re-adding the ingest label", () => {
    const url = envelopeEndpointFromDsn(DSN)?.url ?? "";
    expect(url).toContain("o0123456789abcdef.ingest.us.sentry.io");
    expect(url).not.toContain("ingest.o");
  });

  it("leaves a self-hosted collector host alone too", () => {
    const out = envelopeEndpointFromDsn(
      "https://key@sentry.internal.example/42",
    );
    expect(out?.url).toContain("sentry.internal.example");
    expect(out?.url).toContain("/api/42/envelope/");
  });

  it("returns null for an unparseable DSN rather than posting nowhere", () => {
    expect(envelopeEndpointFromDsn("")).toBeNull();
    expect(envelopeEndpointFromDsn("not-a-dsn")).toBeNull();
  });
});

describe("probeSentryIngest verdicts", () => {
  it("accepted on a plain 2xx", async () => {
    const r = await run(fakeResponse({ status: 200, body: "{}" }));
    expect(r.verdict).toBe("accepted");
    expect(isIngestHealthy(r)).toBe(true);
  });

  // The exact response seen on 2026-09-28 while the quota was spent.
  it("rate-limited on 429 error_usage_exceeded", async () => {
    const r = await run(
      fakeResponse({
        status: 429,
        body: JSON.stringify({
          detail:
            "Sentry dropped data due to a quota or internal rate limit being reached.",
        }),
        headers: {
          "retry-after": "60",
          "x-sentry-rate-limits":
            "60:default;error;security;attachment:organization:error_usage_exceeded",
        },
      }),
    );
    expect(r.verdict).toBe("rate-limited");
    expect(isIngestHealthy(r)).toBe(false);
    expect(r.rateLimits).toContain("error_usage_exceeded");
  });

  // The subtler trap: 2xx, but Sentry discarded the event anyway.
  it("does not call a 200 healthy when the body says the data was dropped", async () => {
    const r = await run(
      fakeResponse({
        status: 200,
        body: JSON.stringify({ detail: "Sentry dropped data due to a quota" }),
      }),
    );
    expect(r.verdict).toBe("dropped-despite-2xx");
    expect(isIngestHealthy(r)).toBe(false);
  });

  it("rejected-auth on 401 and 403", async () => {
    expect((await run(fakeResponse({ status: 401 }))).verdict).toBe(
      "rejected-auth",
    );
    expect((await run(fakeResponse({ status: 403 }))).verdict).toBe(
      "rejected-auth",
    );
  });

  it("unavailable on 5xx and on a transport throw", async () => {
    expect((await run(fakeResponse({ status: 503 }))).verdict).toBe(
      "unavailable",
    );
    const thrown = await probeSentryIngest({
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
      dsn: DSN,
    });
    expect(thrown.verdict).toBe("unavailable");
    expect(thrown.status).toBe(0);
    expect(thrown.detail).toContain("ECONNREFUSED");
  });

  // A preview or a build machine with no DSN is not a healthy deployment, and
  // saying so beats posting nowhere and reporting success.
  it("reports rejected-auth when there is no DSN at all", async () => {
    const r = await probeSentryIngest({
      send: send(fakeResponse({ status: 200 })),
      dsn: "",
    });
    expect(r.verdict).toBe("rejected-auth");
    expect(r.detail).toContain("NEXT_PUBLIC_SENTRY_DSN");
  });
});

describe("describeIngest", () => {
  it("tells the operator that raising the plan fixes it now, not next month", () => {
    const text = describeIngest({
      verdict: "rate-limited",
      status: 429,
      detail: "dropped",
      rateLimits: "60:default;error:organization:error_usage_exceeded",
      eventId: "b".repeat(32),
    });
    expect(text).toContain("REJECTING error events");
    expect(text).toContain("error_usage_exceeded");
    expect(text).toContain("does not have to wait");
  });

  it("stays accurate for the other verdicts", () => {
    const base: IngestProbeResult = {
      verdict: "accepted",
      status: 200,
      detail: null,
      rateLimits: null,
      eventId: "c".repeat(32),
    };
    expect(describeIngest(base)).toContain("accepting");
    expect(
      describeIngest({ ...base, verdict: "rejected-auth", status: 401 }),
    ).toContain("DSN or public key");
    expect(
      describeIngest({ ...base, verdict: "unavailable", status: 0 }),
    ).toContain("Could not reach");
  });
});

describe("buildErrorEnvelope", () => {
  it("is a two-item envelope: header, then the event", () => {
    const env = buildErrorEnvelope({
      eventId: "d".repeat(32),
      timestamp: new Date("2026-09-28T00:00:00.000Z"),
    });
    const lines = env.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event_id).toBe("d".repeat(32));
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]).event_id).toBe("d".repeat(32));
  });

  // A fixed fingerprint means a canary that runs every five minutes produces
  // one issue with a count, rather than hundreds of near-identical issues.
  it("carries a fixed fingerprint so runs group into one issue", () => {
    const env = buildErrorEnvelope({
      eventId: "e".repeat(32),
      timestamp: new Date(),
    });
    expect(JSON.parse(env.trim().split("\n")[2]).fingerprint).toEqual([
      "sentry-ingest-canary",
    ]);
  });

  // This is an infrastructure probe. It must never become a record about a
  // person, so it carries no user, org, ip or url even when the SDK scope has
  // one.
  it("carries no user, org, ip or url", () => {
    const event = JSON.parse(
      buildErrorEnvelope({ eventId: "f".repeat(32), timestamp: new Date() })
        .trim()
        .split("\n")[2],
    );
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(JSON.stringify(event)).not.toContain("@");
  });
});
