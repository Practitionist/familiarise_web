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

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => {
  const { NextResponse } =
    jest.requireActual<typeof import("next/server")>("next/server");
  return {
    __esModule: true,
    requireApiAuth: () => mockRequireApiAuth(),
    isPrivileged: (role: string | undefined) =>
      role === "ADMIN" || role === "STAFF",
    forbiddenResponse: (error: string, code: string) =>
      NextResponse.json({ error, code }, { status: 403 }),
  };
});

import { NextResponse } from "next/server";
import { POST } from "../../app/api/user/consent/route";
import { operatorHasBeenAskedForConsent } from "../../lib/compliance/operator-consent";

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireApiAuth.mockResolvedValue({
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

it.each(["ADMIN", "STAFF"])(
  "lets %s record their own consent",
  async (role) => {
    mockTx.consentArtifact.findFirst.mockResolvedValue(null);
    mockRequireApiAuth.mockResolvedValue({
      session: { user: { id: "op1", role } },
    });
    expect((await POST()).status).toBe(200);
  },
);

it.each(["CONSULTANT", "CONSULTEE", undefined])(
  "refuses role %s with 403 FORBIDDEN and writes nothing",
  async (role) => {
    mockRequireApiAuth.mockResolvedValue({
      session: { user: { id: "u1", role } },
    });
    const res = await POST();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(mockTx.consentArtifact.createMany).not.toHaveBeenCalled();
  },
);

it("passes a sign-in failure through unchanged", async () => {
  mockRequireApiAuth.mockResolvedValue({
    error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  });
  expect((await POST()).status).toBe(401);
});

it("counts a withdrawn artifact as asked", async () => {
  mockTx.consentArtifact.findFirst.mockResolvedValue({ id: "withdrawn" });
  await expect(operatorHasBeenAskedForConsent("op1")).resolves.toBe(true);
  const where = mockTx.consentArtifact.findFirst.mock.calls[0][0].where;
  expect(where).not.toHaveProperty("withdrawnAt");
});
