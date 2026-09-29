/**
 * @jest-environment node
 */

/**
 * Owner decision 2026-09-26 — staff read payouts and never decide one: the
 * real matrix admits a STAFF GET and refuses a STAFF approve with 403.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-session-lookup", () => ({
  lookupSession: async () => ({
    kind: "found",
    session: { user: { id: "staff_1", role: "STAFF" } },
  }),
}));
// The mandatory-2FA gate (lib/auth-helpers.ts) reads `twoFactorEnabled` with a
// targeted column lookup, because it is deliberately NOT in the session
// payload: a payload boolean is whatever the cookie said when it was signed,
// which is exactly what a stolen cookie carries. So a fixture that stubs
// prisma as `{}` answers 500 rather than the 200 the matrix allows — the gate
// cannot prove enrolment and fails closed. The session below therefore has to
// represent a fully-enrolled staff member, which is what it is testing.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: async () => ({ twoFactorEnabled: true }) },
  },
}));
jest.mock("../../lib/payments/payouts", () => ({}));
jest.mock("../../lib/api/operators", () => ({
  getOperatorPayouts: async () => ({ payouts: [], total: 0 }),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/payouts/route";
import { POST } from "../../app/api/admin/payouts/[id]/route";

it("lets staff list payouts but not approve one", async () => {
  const list = await GET(new NextRequest("https://x.test/api/admin/payouts"));
  expect(list.status).toBe(200);

  const approve = await POST(
    new NextRequest("https://x.test/api/admin/payouts/p1", {
      method: "POST",
      body: JSON.stringify({ action: "approve", reason: "looks right" }),
    }),
    { params: Promise.resolve({ id: "p1" } as never) },
  );
  expect(approve.status).toBe(403);
});
