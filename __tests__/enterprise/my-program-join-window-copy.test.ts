/** My Program's join copy states the attendee join window, whatever it is set to. */

jest.mock("@/lib/appointments/occurrences", () => ({
  CONSULTEE_JOIN_WINDOW_MS: 20 * 60 * 1000,
}));

import {
  JOIN_OPENS_LABEL,
  JOIN_WINDOW_NOTE,
} from "@/app/dashboard/organization/[orgId]/my-program/join-window-copy";

it("derives the minutes from CONSULTEE_JOIN_WINDOW_MS", () => {
  expect(JOIN_OPENS_LABEL).toBe("Opens 20 min before");
  expect(JOIN_WINDOW_NOTE).toContain("within 20 minutes of the start time");
});
