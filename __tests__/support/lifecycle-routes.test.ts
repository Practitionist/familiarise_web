/** @jest-environment node */
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  isPrivileged: jest.fn(),
  requireApiAuth: jest.fn(),
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/auth/org-permissions", () => ({
  __esModule: true,
  hasOrgPermission: jest.fn(),
}));
jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  readAppointmentDetail: jest.fn(),
  canAccessAppointment: jest.fn(),
}));
jest.mock("../../lib/api/appointment-access", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/api/appointment-access"),
  authorizeAppointment: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: { id: "spamLimiter" },
  supportTurnLimiter: { id: "supportTurnLimiter" },
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/support/service", () => ({
  __esModule: true,
  runSupportTurn: jest.fn(),
  ORG_PARTY_CATEGORIES: new Set(["ORG_ADMIN_DISPUTE", "SPONSORSHIP_BILLING"]),
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));
jest.mock("../../lib/support/case-service", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/support/case-service"),
  appendSupportCaseTurn: jest.fn(),
  readSupportCaseForViewer: jest.fn(),
  patchSupportCaseLifecycle: jest.fn(),
  latestCaseDecisionTx: jest.fn(),
}));
jest.mock("../../lib/support/case-access", () => ({
  __esModule: true,
  canCorrespondOnCase: jest.fn(async () => true),
  caseCorrespondentIds: jest.fn(async () => []),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: { findFirst: jest.fn(), findUnique: jest.fn() },
    supportCaseDecision: { findUnique: jest.fn() },
    supportCaseEvidenceRequest: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import {
  requireApiAuth,
  requireBackofficeSurface,
} from "../../lib/auth-helpers";
import { authorizeAppointment } from "../../lib/api/appointment-access";
import { runSupportTurn } from "../../lib/support/service";
import {
  appendSupportCaseTurn,
  latestCaseDecisionTx,
  patchSupportCaseLifecycle,
  readSupportCaseForViewer,
} from "../../lib/support/case-service";
import { CaseConflictError } from "../../lib/support/case-transitions";
import { POST as postMessage } from "../../app/api/support/cases/[caseId]/messages/route";
import { PATCH as patchCase } from "../../app/api/support/cases/[caseId]/route";
import { POST as postTurn } from "../../app/api/appointments/[appointmentId]/support/route";
import { POST as postAppeal } from "../../app/api/support/appeals/route";

const db = jest.mocked(prisma, { shallow: false });
const signedIn = (role: string) => ({
  session: {
    user: { id: role === "CONSULTEE" ? "customer" : "staff", role },
    session: { createdAt: new Date(0) },
  },
});
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const caseParams = { params: Promise.resolve({ caseId: "case-1" }) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireApiAuth).mockResolvedValue(signedIn("CONSULTEE") as never);
  jest.mocked(readSupportCaseForViewer).mockResolvedValue({
    id: "case-1",
    filedByOrganizationNotice: false,
  } as never);
  jest.mocked(appendSupportCaseTurn).mockResolvedValue({
    ok: true,
    replayed: false,
    messages: [],
  } as never);
});

describe("POST /api/support/cases/[caseId]/messages", () => {
  it("passes the customer's reopen request through", async () => {
    const res = await postMessage(
      json("http://test/api/support/cases/case-1/messages", "POST", {
        body: "Still broken",
        reopen: true,
      }),
      caseParams,
    );
    expect(res.status).toBe(201);
    expect(appendSupportCaseTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sender: "USER", reopen: true }),
    );
  });

  it("never lets an operator reopen through a reply", async () => {
    jest.mocked(requireApiAuth).mockResolvedValue(signedIn("STAFF") as never);
    await postMessage(
      json("http://test/api/support/cases/case-1/messages", "POST", {
        body: "Following up",
        reopen: true,
      }),
      caseParams,
    );
    expect(appendSupportCaseTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sender: "AGENT", reopen: undefined }),
    );
  });

  it("returns a refused reopen with its appeal deadline and no Sentry event", async () => {
    jest.mocked(appendSupportCaseTurn).mockResolvedValue({
      ok: false,
      status: 409,
      code: "CASE_DECIDED",
      error: "This request has a decision.",
      appealUntil: "2026-10-25T00:00:00.000Z",
      decisionId: "decision-1",
    } as never);
    const res = await postMessage(
      json("http://test/api/support/cases/case-1/messages", "POST", {
        body: "Still broken",
        reopen: true,
      }),
      caseParams,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "CASE_DECIDED",
      error: "This request has a decision.",
      appealUntil: "2026-10-25T00:00:00.000Z",
      decisionId: "decision-1",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/support/cases/[caseId]", () => {
  beforeEach(() => {
    jest
      .mocked(requireBackofficeSurface)
      .mockResolvedValue(signedIn("STAFF") as never);
  });
  const patch = (body: Record<string, unknown>) =>
    patchCase(
      json("http://test/api/support/cases/case-1", "PATCH", {
        expectedUpdatedAt: "2026-10-20T00:00:00.000Z",
        ...body,
      }),
      caseParams,
    );

  it("refuses a legal hold from staff", async () => {
    const res = await patch({ legalHold: true });
    expect(res.status).toBe(403);
    expect(patchSupportCaseLifecycle).not.toHaveBeenCalled();
  });

  it("lets an admin place a legal hold", async () => {
    jest
      .mocked(requireBackofficeSurface)
      .mockResolvedValue(signedIn("ADMIN") as never);
    jest.mocked(patchSupportCaseLifecycle).mockResolvedValue({
      ok: true,
      previousStatus: "CLOSED",
      supportCase: { id: "case-1", status: "CLOSED" },
    } as never);
    const res = await patch({ legalHold: true });
    expect(res.status).toBe(200);
    expect(patchSupportCaseLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ legalHold: true, actorId: "staff" }),
      expect.any(Date),
      { actorRole: "ADMIN", freshSession: false },
    );
  });

  it("names the open case a reopen collided with", async () => {
    jest.mocked(patchSupportCaseLifecycle).mockResolvedValue({
      ok: false,
      status: 409,
      code: "OPEN_CASE_EXISTS",
      error: "There's already an open request about this.",
      existingCase: {
        id: "newer",
        referenceNumber: "FAM-2",
        caseKey: "c_newer",
      },
    } as never);
    const res = await patch({ status: "OPEN" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "OPEN_CASE_EXISTS",
      existingCase: { caseKey: "c_newer" },
    });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("POST /api/appointments/[appointmentId]/support", () => {
  it("returns a lifecycle conflict as a plain 409", async () => {
    jest.mocked(authorizeAppointment).mockResolvedValue({
      userId: "customer",
      isOrgParty: false,
    } as never);
    jest.mocked(runSupportTurn).mockRejectedValue(
      new CaseConflictError({
        code: "REOPEN_WINDOW_EXPIRED",
        error: "Resolved more than 14 days ago.",
      }),
    );
    const res = await postTurn(
      json("http://test/api/appointments/appt-1/support", "POST", {
        userMessage: "Still broken",
        reopen: true,
      }),
      { params: Promise.resolve({ appointmentId: "appt-1" }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "REOPEN_WINDOW_EXPIRED",
      error: "Resolved more than 14 days ago.",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(runSupportTurn).toHaveBeenCalledWith(
      "appt-1",
      "customer",
      expect.objectContaining({ reopen: true }),
    );
  });

  it("requires a message with a reopen", async () => {
    jest.mocked(authorizeAppointment).mockResolvedValue({
      userId: "customer",
      isOrgParty: false,
    } as never);
    const res = await postTurn(
      json("http://test/api/appointments/appt-1/support", "POST", {
        category: "OTHER",
        reopen: true,
      }),
      { params: Promise.resolve({ appointmentId: "appt-1" }) },
    );
    expect(res.status).toBe(400);
    expect(runSupportTurn).not.toHaveBeenCalled();
  });
});

describe("POST /api/support/appeals", () => {
  it("refuses an appeal of a superseded decision and names the one in force", async () => {
    db.supportCase.findFirst.mockResolvedValue(null);
    db.supportCaseDecision.findUnique.mockResolvedValue({
      id: "decision-1",
      caseId: "case-1",
      decidedById: "staff",
      appealUntil: new Date(Date.now() + 86_400_000),
      supportCase: {
        id: "case-1",
        organizationId: null,
        ownershipScope: "PERSONAL",
        appealOfDecisionId: null,
        appealOfModerationActionId: null,
      },
      supersededBy: { id: "decision-2" },
    } as never);
    jest
      .mocked(latestCaseDecisionTx)
      .mockResolvedValue({ id: "decision-3" } as never);
    const res = await postAppeal(
      json("http://test/api/support/appeals", "POST", {
        decisionId: "decision-1",
        reason: "The expert never joined.",
        clientIntakeId: "intake-1",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "DECISION_SUPERSEDED",
      latestDecisionId: "decision-3",
    });
  });
});
