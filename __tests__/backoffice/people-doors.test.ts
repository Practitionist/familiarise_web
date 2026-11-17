/**
 * @jest-environment node
 */

/**
 * The people doors (a verification decision, a report status change, a
 * moderation action, an unban and a review removal) each need a reason, write
 * one OpsActionLog row with the actor and the before and after, and answer a
 * lost compare-and-set with 409.
 */

import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const mockAfter = jest.fn();
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (...args: unknown[]) => mockAfter(...args),
}));

const mockRole: { current: "ADMIN" | "STAFF" } = { current: "ADMIN" };
jest.mock("../../lib/auth-helpers", () => {
  const { NextResponse } =
    jest.requireActual<typeof import("next/server")>("next/server");
  const { hasBackofficePermission } = jest.requireActual<
    typeof import("../../lib/auth/backoffice-permissions")
  >("../../lib/auth/backoffice-permissions");
  return {
    isPrivileged: (role: string | undefined | null) =>
      role === "ADMIN" || role === "STAFF",
    requireBackofficeSurface: async (surface: "users.verify") =>
      hasBackofficePermission(mockRole.current, surface)
        ? { session: { user: { id: "op-1", role: mockRole.current } } }
        : {
            error: NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
          },
  };
});

const mockDb = {
  opsActionLog: { create: jest.fn(async () => ({ id: "ops-row" })) },
  consultantProfileVerification: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  profileVerificationDocument: { updateMany: jest.fn() },
  consultantProfile: { update: jest.fn() },
  moderationReport: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  moderationAction: { create: jest.fn() },
  user: { findUnique: jest.fn(), updateMany: jest.fn() },
  consultantReview: { findUnique: jest.fn(), updateMany: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return {
      ...mockDb,
      $transaction: (run: (tx: typeof mockDb) => Promise<unknown>) =>
        run(mockDb),
    };
  },
}));

jest.mock("../../lib/verification/submit-request", () => ({
  countAnsweredRounds: async () => 0,
}));
jest.mock("../../lib/profiles/profile-completion", () => ({
  recomputeProfileCompletion: async () => 50,
}));
jest.mock("../../lib/novu", () => ({
  notifyVerificationStatusChanged: async () => null,
  notifyAccountSecurityNotice: async () => [],
  attemptTrigger: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  stageVerificationDecidedEmail: async () => null,
  attemptOnboardingEmail: jest.fn(),
}));
jest.mock("../../lib/email/senders/people", () => ({
  stageAccountModerationEmail: async () => [],
}));
jest.mock("../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: jest.fn(),
  purgeReviewSurfaces: jest.fn(),
}));
jest.mock("../../lib/reviews", () => ({
  recomputeConsultantRating: jest.fn(),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
const mockRestore = jest.fn();
jest.mock("../../lib/moderation/side-effects", () => ({
  prepareModerationNotices: async () => ({}),
  applyTransactionalEffects: async () => ({}),
  applyBestEffortEffects: async () => ({}),
  persistActionSideEffects: jest.fn(),
  restoreStreamAccess: (...args: unknown[]) => mockRestore(...args),
}));

import { PATCH as verificationPatch } from "../../app/api/admin/verification/[verificationId]/route";
import { PATCH as reportPatch } from "../../app/api/staff/moderation/reports/[reportId]/route";
import { POST as reportAction } from "../../app/api/staff/moderation/reports/[reportId]/action/route";
import { POST as reportUnban } from "../../app/api/staff/moderation/reports/[reportId]/unban/route";
import { DELETE as reviewDelete } from "../../app/api/staff/moderation/reviews/[reviewId]/route";
import {
  moderationActionBody,
  reviewRemovalBody,
  unbanBody,
  verificationReviewBody,
} from "../../lib/backoffice/people-door-bodies";

const REASON = "Checked against the evidence";
const req = (method: string, body: unknown) =>
  new NextRequest("http://test/door", { method, body: JSON.stringify(body) });
const params = <K extends string>(key: K, id = "row-1") => ({
  params: Promise.resolve({ [key]: id } as Record<K, string>),
});

const auditRow = () => {
  const calls = mockDb.opsActionLog.create.mock.calls as unknown as [
    [{ data: Record<string, unknown> }],
  ];
  return calls[0]?.[0].data;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRole.current = "ADMIN";
  mockDb.consultantProfileVerification.findUnique
    .mockReset()
    .mockResolvedValueOnce({
      status: "PENDING",
      consultantProfileId: "cp-1",
      consultantProfile: { userId: "u-1" },
    })
    .mockResolvedValue({ id: "row-1", status: "APPROVED", documents: [] });
  mockDb.consultantProfileVerification.updateMany.mockResolvedValue({
    count: 1,
  });
  mockDb.moderationReport.findUnique.mockResolvedValue({
    id: "row-1",
    type: "USER",
    reason: "SPAM",
    status: "PENDING",
    assignedToId: null,
    reportedById: "u-2",
    targetUserId: "u-3",
    reviewId: null,
    streamMessageId: null,
    review: null,
  });
  mockDb.moderationReport.updateMany.mockResolvedValue({ count: 1 });
  mockDb.moderationReport.findUniqueOrThrow.mockResolvedValue({
    id: "row-1",
    status: "ACTION_TAKEN",
  });
  mockDb.moderationAction.create.mockResolvedValue({ id: "act-1" });
  mockDb.user.updateMany.mockResolvedValue({ count: 1 });
  mockDb.consultantReview.findUnique.mockResolvedValue({
    consultantProfileId: "cp-1",
    deletedAt: null,
    removedBy: null,
  });
  mockDb.consultantReview.updateMany.mockResolvedValue({ count: 1 });
});

interface DoorCase {
  name: string;
  call: (body: Record<string, unknown>) => Promise<Response>;
  body: Record<string, unknown>;
  surface: string;
  action: string;
  target: { kind: string; id: string };
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Makes the door's compare-and-set miss. */
  loseRace: () => void;
  raceCode: string;
}

const doors: DoorCase[] = [
  {
    name: "PATCH /api/admin/verification/[id]",
    call: (b) => verificationPatch(req("PATCH", b), params("verificationId")),
    body: { status: "APPROVED" },
    surface: "users.verify",
    action: "verification.review",
    target: { kind: "ConsultantProfileVerification", id: "row-1" },
    before: { status: "PENDING" },
    after: { status: "APPROVED", profileStatus: "VERIFIED" },
    loseRace: () =>
      mockDb.consultantProfileVerification.updateMany.mockResolvedValue({
        count: 0,
      }),
    raceCode: "ALREADY_DECIDED",
  },
  {
    name: "PATCH /api/staff/moderation/reports/[id]",
    call: (b) => reportPatch(req("PATCH", b), params("reportId")),
    body: {
      status: "UNDER_REVIEW",
      expectedStatus: "PENDING",
      expectedAssignedToId: null,
    },
    surface: "moderation.manage",
    action: "moderation.report.update",
    target: { kind: "ModerationReport", id: "row-1" },
    before: { status: "PENDING", assignedToId: null },
    after: {},
    loseRace: () =>
      mockDb.moderationReport.updateMany.mockResolvedValue({ count: 0 }),
    raceCode: "REPORT_CHANGED",
  },
  {
    name: "POST /api/staff/moderation/reports/[id]/action",
    call: (b) => reportAction(req("POST", b), params("reportId")),
    body: { actionType: "WARNING_ISSUED" },
    surface: "moderation.manage",
    action: "moderation.action.WARNING_ISSUED",
    target: { kind: "ModerationReport", id: "row-1" },
    before: { reportStatus: "PENDING" },
    after: {
      status: "SUCCEEDED",
      reportStatus: "ACTION_TAKEN",
      actionType: "WARNING_ISSUED",
      actionId: "act-1",
    },
    loseRace: () =>
      mockDb.moderationReport.updateMany.mockResolvedValue({ count: 0 }),
    raceCode: "REPORT_RESOLVED",
  },
  {
    name: "DELETE /api/staff/moderation/reviews/[id]",
    call: (b) => reviewDelete(req("DELETE", b), params("reviewId")),
    body: {},
    surface: "users.moderate",
    action: "moderation.review.remove",
    target: { kind: "ConsultantReview", id: "row-1" },
    before: { deletedAt: null, removedBy: null },
    after: { removedBy: "MODERATION" },
    loseRace: () =>
      mockDb.consultantReview.updateMany.mockResolvedValue({ count: 0 }),
    raceCode: "REVIEW_ALREADY_REMOVED",
  },
];

describe.each(doors)("$name", (door) => {
  it("refuses a missing or short reason with 400 and writes nothing", async () => {
    for (const reason of [undefined, "ok"]) {
      const res = await door.call({ ...door.body, reason });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "INVALID_BODY",
      });
    }
    expect(mockDb.opsActionLog.create).not.toHaveBeenCalled();
    expect(mockDb.moderationReport.updateMany).not.toHaveBeenCalled();
    expect(
      mockDb.consultantProfileVerification.updateMany,
    ).not.toHaveBeenCalled();
    expect(mockDb.consultantReview.updateMany).not.toHaveBeenCalled();
  });

  it("writes one audit row with the actor, the reason, the before and the after", async () => {
    const res = await door.call({ ...door.body, reason: REASON });
    expect(res.status).toBe(200);
    expect(mockDb.opsActionLog.create).toHaveBeenCalledTimes(1);
    expect(auditRow()).toMatchObject({
      actorUserId: "op-1",
      actorRole: "ADMIN",
      surface: door.surface,
      action: door.action,
      targetKind: door.target.kind,
      targetId: door.target.id,
      reason: REASON,
      before: door.before,
      after: door.after,
    });
  });

  it("answers a lost compare-and-set with 409", async () => {
    door.loseRace();
    const res = await door.call({ ...door.body, reason: REASON });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: door.raceCode });
  });
});

describe("POST /api/staff/moderation/reports/[id]/unban", () => {
  const unban = (body: Record<string, unknown>) =>
    reportUnban(req("POST", body), params("reportId"));

  it("refuses STAFF and a missing reason", async () => {
    mockRole.current = "STAFF";
    expect((await unban({ reason: REASON })).status).toBe(403);
    mockRole.current = "ADMIN";
    expect((await unban({})).status).toBe(400);
    expect(mockDb.user.updateMany).not.toHaveBeenCalled();
  });

  it("lifts the ban with a CAS on banned and audits who, why and what Stream said", async () => {
    mockRestore.mockResolvedValue(undefined);
    expect((await unban({ reason: REASON })).status).toBe(200);
    expect(mockDb.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-3", banned: true } }),
    );
    expect(auditRow()).toMatchObject({
      surface: "users.moderate",
      action: "moderation.unban",
      reason: REASON,
      before: { userId: "u-3", banned: true },
      after: { status: "SUCCEEDED", lifted: true, stream: "ok" },
    });
  });

  it("re-applies Stream to an account that is not banned and says so in the row", async () => {
    mockDb.user.updateMany.mockResolvedValue({ count: 0 });
    const res = await unban({ reason: REASON });
    expect(res.status).toBe(200);
    expect(mockRestore).toHaveBeenCalledWith("u-3");
    expect(auditRow()).toMatchObject({
      after: { status: "SUCCEEDED", lifted: false },
    });
  });
});

it("a moderation ban by STAFF is refused inside the door and audited as FAILED", async () => {
  mockRole.current = "STAFF";
  const res = await reportAction(
    req("POST", { actionType: "USER_BANNED", reason: REASON }),
    params("reportId"),
  );
  expect(res.status).toBe(403);
  expect(mockDb.moderationReport.updateMany).not.toHaveBeenCalled();
  expect(auditRow()).toMatchObject({
    after: { status: "FAILED", code: "FORBIDDEN" },
  });
});

it("the verification decision purges and attempts the notices only after commit", async () => {
  await verificationPatch(
    req("PATCH", { status: "APPROVED", reason: REASON }),
    params("verificationId"),
  );
  expect(mockAfter).toHaveBeenCalledWith(
    expect.any(Function),
    "ops:verification.review",
  );
});

describe("what the controls send is what the doors accept", () => {
  it("a suspension from the moderation page or User 360", async () => {
    const res = await reportAction(
      req(
        "POST",
        moderationActionBody({
          actionType: "USER_SUSPENDED",
          reason: REASON,
          note: "Second warning this month",
          suspensionDays: 7,
        }),
      ),
      params("reportId"),
    );
    expect(res.status).toBe(200);
    expect(auditRow()).toMatchObject({ reason: REASON });
  });

  it("lifting a ban", async () => {
    const res = await reportUnban(
      req("POST", unbanBody({ reason: REASON, note: "Appeal upheld" })),
      params("reportId"),
    );
    expect(res.status).toBe(200);
  });

  it("removing a review", async () => {
    const res = await reviewDelete(
      req("DELETE", reviewRemovalBody(REASON)),
      params("reviewId"),
    );
    expect(res.status).toBe(200);
  });

  it("a verification decision with applicant feedback", async () => {
    const res = await verificationPatch(
      req(
        "PATCH",
        verificationReviewBody({
          status: "NEEDS_INFO",
          reason: REASON,
          applicantReason: "The certificate scan is blurred",
          documentFeedback: [],
        }),
      ),
      params("verificationId"),
    );
    expect(res.status).toBe(200);
    expect(auditRow()).toMatchObject({ after: { status: "NEEDS_INFO" } });
  });
});
