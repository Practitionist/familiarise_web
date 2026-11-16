/**
 * @jest-environment node
 */

/**
 * The remediation From/Until inputs are IST wall times: what the control
 * sends names the IST instants, whatever zone the browser runs in, and parses
 * with the route's own input schema. Run under TZ=UTC and America/Los_Angeles.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../actions/maintenance/freeze-appointments", () => ({
  freezeAppointments: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({ withCronLock: jest.fn() }));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
}));

import { previewBody } from "../../components/dashboard/MaintenanceBookingRemediation";
import { remediationInput } from "../../lib/maintenance-remediation";

it("sends the IST window as instants the route accepts", () => {
  const body = previewBody("window", "2026-04-01T05:30", "2026-04-01T07:00");
  expect(body).toEqual({
    windowId: "window",
    startsAt: "2026-04-01T00:00:00.000Z",
    endsAt: "2026-04-01T01:30:00.000Z",
  });
  expect(remediationInput.parse(body)).toEqual(body);
});

it("refuses a half-filled window before sending", () => {
  expect(() => previewBody("window", "2026-04-01T05:30", "")).toThrow(
    "Enter both times in full (IST).",
  );
});
