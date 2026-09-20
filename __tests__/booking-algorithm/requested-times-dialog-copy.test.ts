/**
 * #1705 — the requested-times dialog's failure copy and the toast map's
 * dead entries. A 401 from validate is a known platform face (#1716) and must
 * read as "sign in again", never "Unauthorized"; the two 409 codes that route
 * to requestChangedElsewhere() no longer carry a second title in the map.
 */

import "./setup";

import {
  allocationFailedWithCode,
  classifyValidationFailure,
  requestChangedElsewhere,
  signInHref,
  validationFailureCopy,
} from "@/lib/scheduling/allocationMessages";
import { REQUEST_INDETERMINATE_ERROR } from "@/lib/scheduling/allocationService";

describe("validation failure copy", () => {
  it("maps 401, 403, 5xx/network and a plain refusal", () => {
    expect(classifyValidationFailure(401)).toBe("session-ended");
    expect(classifyValidationFailure(403)).toBe("forbidden");
    // #1716 — a 503 is a refusal with nothing done (a failed session lookup,
    // a lock outage), so it carries the route's own "try again" sentence.
    expect(classifyValidationFailure(503)).toBe("retry-later");
    expect(classifyValidationFailure(502)).toBe("indeterminate");
    expect(classifyValidationFailure(undefined)).toBe("indeterminate");
    expect(classifyValidationFailure(409)).toBe("refused");

    expect(validationFailureCopy("session-ended", "Unauthorized")).toMatch(
      /sign in again/,
    );
    expect(validationFailureCopy("forbidden", "Forbidden")).toBe(
      "You can't schedule this booking.",
    );
    expect(validationFailureCopy("indeterminate", "boom")).toBe(
      REQUEST_INDETERMINATE_ERROR,
    );
    expect(validationFailureCopy("refused", "Slot taken")).toBe("Slot taken");
    expect(
      validationFailureCopy(
        "retry-later",
        "We couldn't confirm your session just now. Try again in a moment.",
      ),
    ).toMatch(/try again in a moment/i);
  });

  it("keeps the current page as callbackUrl on the sign-in link", () => {
    expect(signInHref("/dashboard/consultant/c1/requests")).toBe(
      "/auth/signin?callbackUrl=%2Fdashboard%2Fconsultant%2Fc1%2Frequests",
    );
  });
});

describe("one title per situation", () => {
  it("the two request-changed codes fall through to the generic title, not a second headline", () => {
    for (const code of ["RESCHEDULE_STATE_CHANGED", "ILLEGAL_TRANSITION"]) {
      expect(allocationFailedWithCode("stale", code).title).toBe(
        "Couldn't save timings",
      );
    }
    expect(requestChangedElsewhere().title).toBe("Request changed");
  });
});
