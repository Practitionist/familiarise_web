/** @jest-environment node */

jest.mock("../../lib/maintenance-edge", () => ({
  ...jest.requireActual("../../lib/maintenance-edge"),
  getMaintenanceState: async () => ({
    phase: "OFF",
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  isBypassableIp: () => false,
}));

import { NextRequest } from "next/server";
import {
  CLIENT_IP_HEADER,
  edgeClientIp,
  stampedClientIp,
  type EdgeHost,
} from "@/lib/request-ip";
import { middleware } from "../../middleware";

const forged = new Headers({
  "x-nf-client-connection-ip": "6.6.6.6",
  "x-vercel-forwarded-for": "7.7.7.7",
  "fly-client-ip": "8.8.8.8",
  "x-forwarded-for": "9.9.9.9, 203.0.113.10",
  [CLIENT_IP_HEADER]: "5.5.5.5",
});

describe("the edge resolves the client IP per host", () => {
  it.each<[string, EdgeHost, string]>([
    ["Netlify and generic hosts take the rightmost hop", {}, "203.0.113.10"],
    ["Vercel takes its own header", { VERCEL: "1" }, "7.7.7.7"],
    ["Fly takes its own header", { FLY_APP_NAME: "familiarise" }, "8.8.8.8"],
  ])("%s", (_, host, ip) => {
    expect(edgeClientIp(forged, host)).toBe(ip);
  });

  it("never falls back to a header the host does not own", () => {
    const xff = new Headers({ "x-forwarded-for": "9.9.9.9" });
    expect(edgeClientIp(xff, { VERCEL: "1" })).toBe("unknown_ip");
  });
});

it("Node code trusts only the stamped header", () => {
  expect(stampedClientIp(forged)).toBe("5.5.5.5");
  expect(stampedClientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }))).toBe(
    "unknown_ip",
  );
});

it.each(["/api/auth/request-password-reset", "/api/x/a.json", "/pricing"])(
  "middleware overwrites a forged stamp on %s",
  async (path) => {
    const request = new NextRequest(`http://localhost${path}`, {
      headers: forged,
    });
    const res = await middleware(request);
    expect(res.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBe(
      "203.0.113.10",
    );
  },
);
