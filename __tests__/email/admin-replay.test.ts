/** @jest-environment node */
import { NextRequest } from "next/server";
const mockFind = jest.fn();
const mockMove = jest.fn();
const mockAudit = jest.fn();
const mockPolicy = jest.fn();
const mockSuppression = jest.fn();
const mockUserRead = jest.fn();
const mockTx = {
  user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
  failedEmail: {
    findMany: (...args: unknown[]) => mockFind(...args),
    updateMany: (...args: unknown[]) => mockMove(...args),
  },
  opsActionLog: { create: (...args: unknown[]) => mockAudit(...args) },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (run: (tx: typeof mockTx) => Promise<unknown>) =>
      run(mockTx),
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@/lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin1", role: "ADMIN" } },
  })),
}));
jest.mock("@/lib/email/delivery-policy", () => ({
  ...jest.requireActual<typeof import("@/lib/email/delivery-policy")>(
    "@/lib/email/delivery-policy",
  ),
  emailPolicyRefusalForUser: (...args: unknown[]) => mockPolicy(...args),
}));
jest.mock("@/lib/email/suppression", () => ({
  ...jest.requireActual<typeof import("@/lib/email/suppression")>(
    "@/lib/email/suppression",
  ),
  findSuppressed: (...args: unknown[]) => mockSuppression(...args),
}));
import { POST } from "@/app/api/admin/failed-emails/route";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
const recent = new Date();
const row = {
  id: "fe1",
  status: "DEAD_LETTER",
  emailType: "PAYMENT_SUCCESS",
  lastError: "provider unavailable",
  resendId: null,
  sentAt: null,
  createdAt: recent,
  updatedAt: recent,
  recipient: "test@example.test",
  deliveryPolicy: { userId: "u1", category: "payments" },
};
function post(body: unknown) {
  return POST(
    new NextRequest("https://example.test/api/admin/failed-emails", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockResolvedValue([row]);
  mockMove.mockResolvedValue({ count: 1 });
  mockAudit.mockResolvedValue({ id: "audit1" });
  mockPolicy.mockReturnValue(null);
  mockSuppression.mockResolvedValue(new Map());
  mockUserRead.mockResolvedValue([
    {
      id: "u1",
      email: "test@example.test",
      erasedAt: null,
      orgWorkspaceProfile: null,
      notificationPreferences: null,
    },
  ]);
});
it("requires the existing admin gate and a recorded reason", async () => {
  expect((await post({ ids: ["fe1"] })).status).toBe(400);
  expect(requireBackofficeSurface).toHaveBeenCalledWith("compliance.manage", {
    expectUser: true,
  });
  expect(mockMove).not.toHaveBeenCalled();
});
it("rechecks recipient policy in the transaction and conditionally requeues with one audit record", async () => {
  const response = await post({
    ids: ["fe1", "fe1"],
    reason: "Provider recovered",
  });
  expect(response.status).toBe(200);
  expect(mockPolicy).toHaveBeenCalledWith(
    row.deliveryPolicy,
    row.recipient,
    expect.objectContaining({ id: "u1" }),
  );
  expect(mockUserRead).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: { in: ["u1"] } } }),
  );
  expect(mockSuppression).toHaveBeenCalledWith([row.recipient], mockTx);
  expect(mockMove).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { status: "DEAD_LETTER", OR: [{ id: "fe1", updatedAt: recent }] },
    }),
  );
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: "admin1",
        action: "email.retry",
        reason: "Provider recovered",
      }),
    }),
  );
});
it.each([
  { emailType: "PASSWORD_RESET" },
  { lastError: "held:pre-launch" },
  { lastError: "policy:erased" },
  { resendId: "accepted" },
  { createdAt: new Date(Date.now() - 25 * 3600000) },
])(
  "refuses protected or ambiguous replay without clearing its evidence",
  async (changes) => {
    mockFind.mockResolvedValue([{ ...row, ...changes }]);
    expect(
      (await post({ ids: ["fe1"], reason: "Provider recovered" })).status,
    ).toBe(409);
    expect(mockMove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);
it("refuses current policy/suppression and a concurrent replay", async () => {
  mockSuppression.mockResolvedValueOnce(
    new Map([[row.recipient, "COMPLAINT"]]),
  );
  expect(
    (await post({ ids: ["fe1"], reason: "Provider recovered" })).status,
  ).toBe(409);
  expect(mockMove).not.toHaveBeenCalled();
  mockMove.mockResolvedValueOnce({ count: 0 });
  expect(
    (await post({ ids: ["fe1"], reason: "Provider recovered" })).status,
  ).toBe(409);
  expect(mockAudit).not.toHaveBeenCalled();
});

it("keeps the supported bulk retry bounded to one account read and one suppression read", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...row,
    id: `fe${i}`,
  }));
  mockFind.mockResolvedValue(rows);
  mockMove.mockResolvedValue({ count: 200 });
  expect(
    (await post({ ids: rows.map((r) => r.id), reason: "Provider recovered" }))
      .status,
  ).toBe(200);
  expect(mockUserRead).toHaveBeenCalledTimes(1);
  expect(mockSuppression).toHaveBeenCalledTimes(1);
  expect(mockAudit).toHaveBeenCalledTimes(1);
});
