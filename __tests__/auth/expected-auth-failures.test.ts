/**
 * @jest-environment node
 */

/**
 * `lib/auth/expected-auth-failures.ts` — the predicate that decides whether a
 * failure on the auth pages is the platform (row 6's cold-instance stall) or us.
 *
 * The cost of getting this wrong is asymmetric and that asymmetry is the whole
 * design: too narrow costs one missing alert, too wide silently buries a real
 * defect. So the "not an unreachable transport error" cases below are the ones
 * worth having.
 */

import {
  isUnreachableTransportError,
  markExpectedUnreachable,
} from "@/lib/auth/expected-auth-failures";
import { isExpectedError } from "@/lib/observability/expected";

describe("isUnreachableTransportError", () => {
  // BREAKS IF DELETED: the signin/signup pages stop marking the one failure the
  // failure-modes matrix says is expected, and a Netlify stall pages on-call
  // every time it happens — which is the state row 19 was written to end.
  it("accepts the browser's rejected-fetch TypeError", () => {
    expect(
      isUnreachableTransportError(new TypeError("Failed to fetch")),
    ).toBe(true);
  });

  // BREAKS IF DELETED: Firefox/Safari — which the auth pages are read on by
  // real corporate users, the row-16 population — stop matching, and the same
  // stall pages for them only.
  it("accepts the Firefox wording, which is not 'Failed to fetch'", () => {
    expect(
      isUnreachableTransportError(
        new TypeError(
          "NetworkError when attempting to fetch resource.",
        ),
      ),
    ).toBe(true);
  });

  // BREAKS IF DELETED: opaque CORS / `net::ERR_*` failures, which better-fetch
  // resolves rather than throws as `{ status: 0 }`, stop being marked.
  it("accepts a resolved failure carrying status 0, whatever its message", () => {
    expect(
      isUnreachableTransportError({
        status: 0,
        message: "Load failed",
        name: "TypeError",
      }),
    ).toBe(true);
  });

  // BREAKS IF DELETED: the marker widens onto "any TypeError mentioning fetch",
  // and a plain `x.fetch is not a function` — our bug, on the same object shape
  // — arrives at warning with nobody paged. This is the case the name check
  // exists for.
  it("rejects a genuine TypeError about our own code that mentions fetch", () => {
    expect(
      isUnreachableTransportError(
        new TypeError("captcha.refresh is not a function"),
      ),
    ).toBe(false);
    expect(isUnreachableTransportError(new TypeError("Failed to parse URL"))).toBe(
      false,
    );
  });

  // BREAKS IF DELETED: the predicate starts swallowing faults, which is worse
  // than missing one — a 500 from our own handler and a thrown string would both
  // be re-levelled to warning.
  it("rejects non-transport failures, non-objects and non-errors", () => {
    expect(isUnreachableTransportError(new Error("boom"))).toBe(false);
    expect(isUnreachableTransportError({ status: 500, message: "boom" })).toBe(
      false,
    );
    expect(isUnreachableTransportError({ status: 401 })).toBe(false);
    expect(isUnreachableTransportError(null)).toBe(false);
    expect(isUnreachableTransportError("Failed to fetch")).toBe(false);
    expect(isUnreachableTransportError(undefined)).toBe(false);
  });
});

describe("markExpectedUnreachable", () => {
  // BREAKS IF DELETED: the object marker never reaches the capture on the two
  // auth pages, so the `beforeSend` re-levelling that `sentry.shared.config.ts`
  // documents stops happening for a thrown fetch.
  it("marks a transport failure and reports that it did", () => {
    const err = new TypeError("Failed to fetch");
    const out = markExpectedUnreachable(err);
    expect(out.marked).toBe(true);
    expect(out.error).toBe(err);
    expect(isExpectedError(out.error)).toBe(true);
  });

  // BREAKS IF DELETED: a real defect on the sign-in or sign-up path gets
  // downgraded to warning, and the row-19 fix becomes the bug it was meant to
  // prevent. Un-marked is the default on purpose.
  it("leaves an unrecognised failure untouched and says so", () => {
    const err = new Error("Cannot read properties of undefined");
    const out = markExpectedUnreachable(err);
    expect(out.marked).toBe(false);
    expect(out.error).toBe(err);
    expect(isExpectedError(err)).toBe(false);
  });
});
