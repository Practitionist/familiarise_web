/**
 * @jest-environment node
 */

// Invariant: a booking/money write fails closed on unreadable maintenance state,
// even when it carries the RSC header that lets reads answer from the cache.

const fresh = jest.fn();
const cachedOnly = jest.fn();
jest.mock("../../lib/maintenance-edge", () => ({
  ...jest.requireActual("../../lib/maintenance-edge"),
  getMaintenanceState: () => fresh(),
  getMaintenanceStateCachedOnly: () => cachedOnly(),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  getClientIp: () => "203.0.113.1",
  isBypassableIp: () => false,
}));

import { NextRequest } from "next/server";
import { NextFetchEvent } from "next/dist/server/web/spec-extension/fetch-event";
import { middleware } from "../../middleware";

const OFF = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

it("answers 503 to an RSC-flagged checkout write when the state is unreadable", async () => {
  fresh.mockResolvedValue({ ...OFF, unreadable: true });
  cachedOnly.mockReturnValue(OFF);

  const request = new NextRequest("http://localhost/api/checkout", {
    method: "POST",
    headers: { RSC: "1" },
  });
  const event = new NextFetchEvent({
    request,
    page: "/api/checkout",
    context: { waitUntil: () => undefined },
  });

  const res = await middleware(request, event);

  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  expect(cachedOnly).not.toHaveBeenCalled();
});

it("refuses an anonymous notify-me write before it reaches the route", async () => {
  fresh.mockResolvedValue(OFF);
  cachedOnly.mockReturnValue(OFF);
  const request = new NextRequest(
    "http://localhost/api/scheduling/event-waitlist",
    { method: "POST" },
  );
  const event = new NextFetchEvent({
    request,
    page: "/api/scheduling/event-waitlist",
    context: { waitUntil: () => undefined },
  });

  const res = await middleware(request, event);

  expect(res.status).toBe(401);
});
