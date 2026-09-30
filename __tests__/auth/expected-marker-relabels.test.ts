/**
 * @jest-environment node
 */

/**
 * Failure-modes row 19: `markExpected` has no call site, so every expected auth
 * failure pages on-call while behaving correctly. These cases prove the
 * *mechanism* rather than the call: they run the repo's real `initSentry` (the
 * same `beforeSend` production uses), capture through each of the four routes an
 * auth file can take, and assert on the event that actually reached the
 * transport.
 *
 * Asserting that `markExpected` was *called* would pass against a broken SDK
 * contract and catch nothing — the whole point of the row is that a call which
 * looks right and does nothing is worse than no call, so the assertion has to be
 * on the outgoing event's `level` and `tags`.
 */

import type { ErrorEvent } from "@sentry/nextjs";

const sent: ErrorEvent[] = [];

/**
 * A recording transport. `initSentry` layers caller overrides LAST
 * (`sentry.shared.config.ts:165`), so overriding only `transport` keeps the
 * repo's real `beforeSend` in the pipeline — which is the code under test.
 */
jest.mock("@sentry/nextjs", () => {
  const actual = jest.requireActual("@sentry/nextjs");
  return {
    ...actual,
    init: (options: Record<string, unknown>) => {
      const { init } = jest.requireActual("@sentry/nextjs");
      return init({
        ...options,
        transport: () => ({
          // A v10 envelope is `[header, [[itemHeader, itemPayload], …]]`, so the
          // payload is the second element of each item pair. Recorded verbatim
          // so the assertions read the event that actually went out, after the
          // repo's own `beforeSend` has run.
          send: (envelope: unknown) => {
            const items = (envelope as unknown[])[1];
            if (Array.isArray(items)) {
              for (const item of items) {
                if (Array.isArray(item) && item[1]) sent.push(item[1] as ErrorEvent);
              }
            }
            return Promise.resolve({ status: "success" });
          },
          flush: () => Promise.resolve(true),
        }),
      });
    },
  };
});

jest.mock("next/headers", () => ({ headers: jest.fn() }));
// `lib/auth-session-lookup` reaches `lib/auth-server` -> `lib/auth` -> the
// ESM-only `better-auth/plugins`, which this jest config does not transform.
// The lookup's own logic is covered elsewhere; it is imported here only for the
// error class, so a bare stub is the honest dependency.
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import * as Sentry from "@sentry/nextjs";
import { initSentry } from "../../sentry.shared.config";
import { markExpected, isExpectedError } from "@/lib/observability/expected";
import { reportSentryError } from "@/lib/observability/report";
import { SessionLookupFailedError } from "@/lib/auth-session-lookup";

/** Let the SDK's async capture pipeline drain before asserting. */
const flush = () => Sentry.flush(2000);

/** The one event whose exception values mention `needle`. */
function eventFor(needle: string): ErrorEvent {
  const match = sent.filter((e) =>
    JSON.stringify(e.exception?.values ?? []).includes(needle),
  );
  expect(match).toHaveLength(1);
  return match[0];
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SENTRY_DSN =
    "https://0000000000000000000000000000000@o0.ingest.sentry.io/0";
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "test";
  initSentry();
});

beforeEach(() => {
  sent.length = 0;
});

describe("the marker reaches beforeSend (row 19)", () => {
  // BREAKS IF DELETED: `markExpected` becomes a no-op wrapper and every
  // expected-failure marker in the auth path silently stops re-levelling, which
  // is the exact state row 19 was written about. This is the only assertion that
  // fails if the symbol key changes.
  it("stamps the object, reads the stamp back, and stays out of JSON", () => {
    const err = new Error("stamped");
    expect(isExpectedError(err)).toBe(false);
    expect(markExpected(err)).toBe(err);
    expect(isExpectedError(err)).toBe(true);
    // Non-enumerable: the marker must not survive into a response body or a log
    // line, both of which are scrubbed/logged from these objects.
    expect(Object.keys(err)).not.toContain("expectedError");
    expect(JSON.stringify({ err })).toBe('{"err":{}}');
  });

  // BREAKS IF DELETED: both auth pages' thrown fetch re-level to `error` and
  // page on-call for a platform stall that has already been triaged as
  // expected.
  it("re-levels a direct Sentry.captureException to warning + expected:true", async () => {
    Sentry.captureException(markExpected(new Error("direct-capture")));
    await flush();
    const event = eventFor("direct-capture");
    expect(event.level).toBe("warning");
    expect(event.tags?.expected).toBe("true");
  });

  // BREAKS IF DELETED: `beforeSend` would be unconditionally downgrading, and
  // every real defect in the auth path would arrive at warning with no alert.
  // This is the guard on the guard.
  it("leaves an unmarked captureException at error level", async () => {
    Sentry.captureException(new Error("not-marked"));
    await flush();
    const event = eventFor("not-marked");
    expect(event.level).not.toBe("warning");
    expect(event.tags?.expected).not.toBe("true");
  });

  // BREAKS IF DELETED: auth files could no longer mark at the throw site and
  // report wherever the capture happens, which is the pattern the
  // `sign-in-attempt-hooks` disclosure probe and `requireApiAuth` both rely on.
  it("rides through reportSentryError even when it is told expected:false", async () => {
    reportSentryError(markExpected(new Error("via-report-helper")), {
      subsystem: "auth",
      expected: false,
    });
    await flush();
    const event = eventFor("via-report-helper");
    expect(event.level).toBe("warning");
    expect(event.tags?.expected).toBe("true");
  });

  // BREAKS IF DELETED: the docblock's "does NOT work" claim stops being
  // enforced. If a Sentry upgrade ever made `captureMessage` carry the marker,
  // this fails and forces a decision instead of letting a message-only refusal
  // quietly change level.
  it("does NOT reach a captureMessage — the documented gap", async () => {
    Sentry.captureMessage("marked-message", { level: "error" });
    await flush();
    const event = sent.find((e) => e.message === "marked-message");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
  });

  // BREAKS IF DELETED: `SessionLookupFailedError` loses its constructor-time
  // marker and the one route in this app that takes no per-call capture options
  // — Next's `onRequestError`, which is where a page guard's throw actually
  // goes — goes back to paging. This is the single most important call site in
  // the row and the only one a mock-based test could not have caught.
  it("re-levels the real SessionLookupFailedError through Next's onRequestError", async () => {
    const guard = new SessionLookupFailedError(
      new Error("pool exhausted (P2024)"),
    );
    expect(isExpectedError(guard)).toBe(true);

    Sentry.captureRequestError(
      guard,
      // The cast is the SDK's own request type vs the DOM lib's `Request`; the
      // only fields `captureRequestError` reads are `headers` and `path`, both
      // of which this has.
      new Request("https://example.invalid/dashboard", {
        method: "GET",
      }) as unknown as Parameters<typeof Sentry.captureRequestError>[1],
      {
        routerKind: "App Router",
        routePath: "/dashboard",
        routeType: "render",
      },
    );
    await flush();
    const event = eventFor("pool exhausted");
    expect(event.level).toBe("warning");
    expect(event.tags?.expected).toBe("true");
  });
});
