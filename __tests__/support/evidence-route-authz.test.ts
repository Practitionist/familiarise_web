/** @jest-environment node */
const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: jest.fn(async () => false),
}));
jest.mock("../../lib/support/case-actions", () => ({
  CaseActionError: class extends Error {},
  evidenceRecipients: jest.fn(async () => [{ id: "expert", name: "Expert" }]),
}));
jest.mock("../../lib/support/case-notice", () => ({
  stageCaseNotice: jest.fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: { findFirst: jest.fn() },
    supportCaseEvidenceRequest: { findFirst: jest.fn() },
    supportCaseDecision: { findMany: jest.fn(async () => []) },
    appointment: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { evidenceRecipients } from "../../lib/support/case-actions";
import { GET } from "../../app/api/support/evidence/[requestId]/route";

const db = jest.mocked(prisma, { shallow: false });
const supportCase = {
  id: "case-1",
  appointmentId: "appt-1",
  resolvedAt: null,
  closedAt: null,
  deletedAt: null,
  description: "The complainant's private explanation",
};
const request = {
  id: "req-1",
  caseId: "case-1",
  recipientUserId: "expert",
  prompt: "Describe what happened in the session.",
  dueAt: new Date("2026-10-22T10:00:00Z"),
  responseBody: null,
  respondedAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-10-20T10:00:00Z"),
};
const session = (id: string, role: string) => ({
  session: { user: { id, role } },
});
const call = () =>
  GET(new NextRequest("http://localhost/api/support/evidence/req-1"), {
    params: Promise.resolve({ requestId: "req-1" }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  db.supportCase.findFirst.mockResolvedValue(supportCase as never);
  db.supportCaseEvidenceRequest.findFirst.mockImplementation((async (args: {
    where: { recipientUserId?: string };
  }) =>
    args.where.recipientUserId && args.where.recipientUserId !== "expert"
      ? null
      : request) as never);
});

it("returns 404 to a signed-in user who is not the evidence recipient", async () => {
  mockRequireApiAuth.mockResolvedValue(session("customer", "CONSULTEE"));
  const res = await call();
  expect(res.status).toBe(404);
  expect(db.supportCaseEvidenceRequest.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "req-1", recipientUserId: "customer" },
    }),
  );
});

it("returns 404 to a named recipient who is no longer an eligible party", async () => {
  mockRequireApiAuth.mockResolvedValue(session("expert", "CONSULTANT"));
  jest.mocked(evidenceRecipients).mockResolvedValueOnce([]);
  const res = await call();
  expect(res.status).toBe(404);
});

it("gives the recipient the prompt and outcome without the complainant's correspondence", async () => {
  mockRequireApiAuth.mockResolvedValue(session("expert", "CONSULTANT"));
  const res = await call();
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.prompt).toBe(request.prompt);
  expect(JSON.stringify(data)).not.toContain(supportCase.description);
  expect(data).not.toHaveProperty("messages");
  expect(data).not.toHaveProperty("description");
  expect(data.decisions).toEqual([]);
  expect(db.supportCaseDecision.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      select: { id: true, outcome: true, appealUntil: true, createdAt: true },
    }),
  );
});

it("lets support staff open any evidence request without the recipient filter", async () => {
  mockRequireApiAuth.mockResolvedValue(session("staff-1", "STAFF"));
  const res = await call();
  expect(res.status).toBe(200);
  expect(db.supportCaseEvidenceRequest.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "req-1" } }),
  );
});
