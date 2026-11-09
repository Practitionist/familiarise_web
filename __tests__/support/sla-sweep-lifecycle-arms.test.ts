/** @jest-environment node */
const mockCascade = jest.fn();
const mockPurge = jest.fn();
const mockChatSweep = jest.fn();
const mockFlush = jest.fn(async (..._args: unknown[]) => undefined);
const mockReportSentryError = jest.fn();
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    async (_job: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../../lib/support/problem-cascade", () => ({
  HELD_OPEN_SCAN_FACTOR: 2,
  cascadeResolvedProblems: (...args: unknown[]) => mockCascade(...args),
}));
jest.mock("../../lib/support/evidence-retention", () => ({
  purgeExpiredSupportEvidence: (...args: unknown[]) => mockPurge(...args),
}));
jest.mock("../../lib/support/chat-sweep", () => ({
  sweepSupportChatAccess: (...args: unknown[]) => mockChatSweep(...args),
}));
jest.mock("../../lib/support/removal-review", () => ({
  hasRemovalReviewWork: async () => false,
  sweepRemovalReviews: async () => ({ decided: 0, refundedOnDeadline: 0 }),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("../../lib/email", () => ({
  deliver: jest.fn(async () => ({ success: true })),
  DEFAULT_FROM_ADDRESS: "support@example.test",
  EMAIL_BUDGET_MS: { JOB: 1000 },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: jest.fn(async () => true),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: { findMany: jest.fn(async () => []) },
    dispute: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    notificationOutbox: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
    },
    failedEmail: { findFirst: jest.fn(async () => null) },
    moderationReport: { findMany: jest.fn(async () => []) },
    supportCaseEvidenceRequest: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(),
  };
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});

import { runSupportSlaSweep } from "../../lib/support/sla-sweep";

const now = new Date("2026-10-22T00:00:00Z");
const bell = { transactionId: "case-status:a" };
const email = { staged: { id: "e1" }, message: { to: "c@example.test" } };
const chatBell = { transactionId: "chat-reviewed:g1:case" };

beforeEach(() => {
  jest.clearAllMocks();
  mockCascade.mockResolvedValue({
    cascaded: 1,
    heldOpen: [],
    bells: [bell],
    emails: [email],
  });
  mockPurge.mockResolvedValue({ casesPurged: 2, filesDeleted: 3 });
  mockChatSweep.mockImplementation(
    async ({ stagedBells }: { stagedBells: unknown[] }) => {
      stagedBells.push(chatBell);
      return { ended: 2, joined: 1, left: 1, boundaries: 3, notices: 1 };
    },
  );
});

it("runs the cascade and purge arms with their own small bounds and reports their counts", async () => {
  const result = await runSupportSlaSweep({ now, limit: 20 });

  expect(mockCascade).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 10, now }),
  );
  expect(mockPurge).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 5, now }),
  );
  expect(mockChatSweep).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 10, now }),
  );
  expect(result).toMatchObject({
    success: true,
    incidentsCascaded: 1,
    evidenceCasesPurged: 2,
    evidenceFilesDeleted: 3,
    chatAccessEnded: 2,
    chatInterventionsJoined: 1,
    chatInterventionsLeft: 1,
    chatBoundariesSynced: 3,
    chatReviewNotices: 1,
  });
  expect(mockFlush).toHaveBeenCalledWith(
    {
      bells: [bell, chatBell],
      emails: [{ rows: [email], emailType: "SUPPORT_TICKET_UPDATE" }],
    },
    "support.sla-sweep",
  );
  expect(mockReportSentryError).not.toHaveBeenCalled();
});

it("never asks an arm for more than the run's limit", async () => {
  await runSupportSlaSweep({ now, limit: 2 });
  expect(mockCascade.mock.calls[0][0].limit).toBe(2);
  expect(mockPurge.mock.calls[0][0].limit).toBe(2);
  expect(mockChatSweep.mock.calls[0][0].limit).toBe(2);
});

it("folds arm failures into the run's errors and reports to Sentry once", async () => {
  mockCascade.mockImplementation(async ({ errors }: { errors: string[] }) => {
    errors.push("problem-cascade incident a: boom");
    errors.push("problem-cascade incident b: boom");
    return { cascaded: 0, heldOpen: [], bells: [], emails: [] };
  });
  mockPurge.mockImplementation(async ({ errors }: { errors: string[] }) => {
    errors.push("evidence-purge case c: 1 file(s) not confirmed deleted");
    return { casesPurged: 0, filesDeleted: 0 };
  });
  mockChatSweep.mockImplementation(async ({ errors }: { errors: string[] }) => {
    errors.push("chat-access leave g1: stream 500");
    return { ended: 0, joined: 0, left: 0, notices: 0 };
  });

  const result = await runSupportSlaSweep({ now, limit: 20 });

  expect(result.success).toBe(false);
  expect(result.errors).toHaveLength(4);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
});
