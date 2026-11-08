/**
 * @jest-environment node
 */

// Invariant: every request awaits the maintenance state, so a booking/money
// write fails closed when it is unreadable, whatever headers it carries.

const fresh = jest.fn();
jest.mock("../../lib/maintenance-edge", () => ({
  ...jest.requireActual("../../lib/maintenance-edge"),
  getMaintenanceState: () => fresh(),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  getClientIp: () => "203.0.113.1",
  isBypassableIp: () => false,
}));

import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

const OFF = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

it("answers 503 to a checkout write when the state is unreadable, RSC header or not", async () => {
  fresh.mockResolvedValue({ ...OFF, unreadable: true });

  const request = new NextRequest("http://localhost/api/checkout", {
    method: "POST",
    headers: { RSC: "1" },
  });
  const res = await middleware(request);

  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  expect(fresh).toHaveBeenCalledTimes(1);
});

it("refuses an anonymous notify-me write before it reaches the route", async () => {
  fresh.mockResolvedValue(OFF);
  const request = new NextRequest(
    "http://localhost/api/scheduling/event-waitlist",
    { method: "POST" },
  );
  const res = await middleware(request);

  expect(res.status).toBe(401);
});
