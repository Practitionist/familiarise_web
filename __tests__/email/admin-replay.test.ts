/** @jest-environment node */
import { NextRequest } from "next/server";
const mockFind = jest.fn();
const mockMove = jest.fn();
const mockAudit = jest.fn();
const mockSuppression = jest.fn();
const mockUserRead = jest.fn();
const mockTx = {
  user: { findMany: (...args: unknown[]) => mockUserRead(...args) },
  failedEmail: {
    findMany: (...args: unknown[]) => mockFind(...args),
    updateMany: (...args: unknown[]) => mockMove(...args),
  },
  emailSuppression: {
    findMany: (...args: unknown[]) => mockSuppression(...args),
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
import { POST } from "@/app/api/admin/failed-emails/route";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const HOUR = 3_600_000;
const recent = new Date();
const row = {
  id: "fe1",
  status: "DEAD_LETTER",
  emailType: "PAYMENT_SUCCESS",
  lastError: "provider unavailable",
  resendId: null,
  sentAt: null,
  firstAttemptAt: recent,
  updatedAt: recent,
  recipient: "test@example.test",
  deliveryUserId: "u1",
  deliveryCategory: "payments",
};
const account = {
  id: "u1",
  email: "test@example.test",
  erasedAt: null,
  notificationPreferences: null,
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
  mockSuppression.mockResolvedValue([]);
  mockUserRead.mockResolvedValue([account]);
});

it("requires the admin gate and a recorded reason", async () => {
  expect((await post({ ids: ["fe1"] })).status).toBe(400);
  expect(requireBackofficeSurface).toHaveBeenCalledWith("compliance.manage", {
    expectUser: true,
  });
  expect(mockMove).not.toHaveBeenCalled();
});

it("rechecks the recipient in the transaction, requeues by CAS and audits once with the prior reason", async () => {
  const response = await post({
    ids: ["fe1", "fe1"],
    reason: "Provider recovered",
  });

  expect(response.status).toBe(200);
  expect(mockUserRead).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: { in: ["u1"] } } }),
  );
  expect(mockSuppression).toHaveBeenCalledWith(
    expect.objectContaining({ where: { email: { in: [row.recipient] } } }),
  );
  expect(mockMove).toHaveBeenCalledWith({
    where: { status: "DEAD_LETTER", OR: [{ id: "fe1", updatedAt: recent }] },
    data: { status: "PENDING", attempts: 0, nextRetryAt: expect.any(Date) },
  });
  // The failure reason is kept on the row and copied into the audit record.
  expect(mockMove.mock.calls[0][0].data).not.toHaveProperty("lastError");
  expect(mockMove.mock.calls[0][0].data).not.toHaveProperty("firstAttemptAt");
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit.mock.calls[0][0].data).toMatchObject({
    actorUserId: "admin1",
    action: "email.retry",
    reason: "Provider recovered",
    before: {
      status: "DEAD_LETTER",
      rows: [{ id: "fe1", lastError: "provider unavailable" }],
    },
  });
});

it("replays a never-attempted dead letter regardless of age", async () => {
  mockFind.mockResolvedValue([
    {
      ...row,
      firstAttemptAt: null,
      updatedAt: new Date(Date.now() - 72 * HOUR),
    },
  ]);
  expect((await post({ ids: ["fe1"], reason: "Key restored" })).status).toBe(
    200,
  );
  expect(mockMove).toHaveBeenCalledTimes(1);
});

it.each([
  { emailType: "PASSWORD_RESET" },
  { lastError: "held:pre-launch" },
  { lastError: "policy:recipient_erased" },
  { lastError: "suppressed:COMPLAINT" },
  { resendId: "accepted" },
  {
    lastError: "review:provider_acceptance_unknown",
    firstAttemptAt: new Date(Date.now() - 25 * HOUR),
  },
  { firstAttemptAt: new Date(Date.now() - 23 * HOUR) },
])(
  "refuses protected or ambiguous replay without touching the row (%#)",
  async (changes) => {
    mockFind.mockResolvedValue([{ ...row, ...changes }]);
    expect(
      (await post({ ids: ["fe1"], reason: "Provider recovered" })).status,
    ).toBe(409);
    expect(mockMove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "a suppression",
    () =>
      mockSuppression.mockResolvedValueOnce([
        { email: row.recipient, reason: "COMPLAINT" },
      ]),
  ],
  [
    "a changed address",
    () =>
      mockUserRead.mockResolvedValueOnce([
        { ...account, email: "new@example.test" },
      ]),
  ],
  [
    "an erased account",
    () =>
      mockUserRead.mockResolvedValueOnce([
        { ...account, erasedAt: new Date() },
      ]),
  ],
])("refuses a recipient now stopped by %s", async (_label, arrange) => {
  arrange();
  const response = await post({ ids: ["fe1"], reason: "Provider recovered" });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("EMAIL_RECIPIENT_REFUSED");
  expect(mockMove).not.toHaveBeenCalled();
});

it("refuses a concurrent change without an audit row", async () => {
  mockMove.mockResolvedValueOnce({ count: 0 });
  const response = await post({ ids: ["fe1"], reason: "Provider recovered" });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("EMAIL_REPLAY_RACED");
  expect(mockAudit).not.toHaveBeenCalled();
});

it("keeps a bulk retry to one account read and one suppression read", async () => {
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
