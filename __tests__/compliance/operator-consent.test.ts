/**
 * @jest-environment node
 */

/**
 * Operators record their own DPDP consent on first sign-in (nobody consents
 * for them when an admin creates the account). The write is self-only,
 * operator-only and idempotent.
 */

const mockTx = {
  consentArtifact: { findFirst: jest.fn(), createMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return {
      ...mockTx,
      $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    };
  },
}));

const mockRequirePrivilegedAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: () => mockRequirePrivilegedAuth(),
}));

import { NextResponse } from "next/server";
import { POST } from "../../app/api/user/consent/route";
import { operatorHasBeenAskedForConsent } from "../../lib/compliance/operator-consent";

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrivilegedAuth.mockResolvedValue({
    session: { user: { id: "op1", role: "STAFF" } },
  });
  mockTx.consentArtifact.createMany.mockResolvedValue({ count: 3 });
});

it("writes the signup purposes for the session's own user", async () => {
  mockTx.consentArtifact.findFirst.mockResolvedValue(null);
  const res = await POST();
  expect(res.status).toBe(200);
  const { data } = mockTx.consentArtifact.createMany.mock.calls[0][0];
  expect(data.map((d: { userId: string }) => d.userId)).toEqual([
    "op1",
    "op1",
    "op1",
  ]);
  expect(
    data.flatMap((d: { purposeCodes: string[] }) => d.purposeCodes),
  ).toEqual([
    "PRIMARY_PROCESSING",
    "STREAM_DATA_PROCESSING",
    "SESSION_BOOKING",
  ]);
});

it("writes nothing when the operator was already asked", async () => {
  mockTx.consentArtifact.findFirst.mockResolvedValue({ id: "a1" });
  const res = await POST();
  await expect(res.json()).resolves.toMatchObject({ created: 0 });
  expect(mockTx.consentArtifact.createMany).not.toHaveBeenCalled();
});

it("refuses non-operators through the privileged gate", async () => {
  mockRequirePrivilegedAuth.mockResolvedValue({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  const res = await POST();
  expect(res.status).toBe(403);
  expect(mockTx.consentArtifact.createMany).not.toHaveBeenCalled();
});

it("counts a withdrawn artifact as asked", async () => {
  mockTx.consentArtifact.findFirst.mockResolvedValue({ id: "withdrawn" });
  await expect(operatorHasBeenAskedForConsent("op1")).resolves.toBe(true);
  const where = mockTx.consentArtifact.findFirst.mock.calls[0][0].where;
  expect(where).not.toHaveProperty("withdrawnAt");
});
