/**
 * @jest-environment node
 */

// The access an erased co-host held is always recorded in the transaction that
// ends the collaboration: in the erasure request's outbox when one is being
// processed, and as the ordinary collaborator intent otherwise.

type RetryRow = {
  kind?: string;
  erasureRequestId?: string;
  planId: string;
  status: string;
};
/** The `StreamRevocationRetry` table, shared by the transaction and the client. */
let retryRows: RetryRow[] = [];
const mockRetryTable = {
  createMany: jest.fn(async (args: unknown) => {
    const { data } = args as { data: Omit<RetryRow, "status">[] };
    retryRows.push(...data.map((row) => ({ ...row, status: "PENDING" })));
    return { count: data.length };
  }),
  updateMany: jest.fn(async (args: unknown) => {
    const { where, data } = args as {
      where: { kind?: string; planId?: string };
      data: { status: string };
    };
    if (data.status !== "SUCCEEDED") return { count: 0 };
    const settled = retryRows.filter(
      (row) => row.kind === where.kind && row.planId === where.planId,
    );
    for (const row of settled) row.status = "SUCCEEDED";
    return { count: settled.length };
  }),
  update: jest.fn(async () => ({})),
};
const mockDrive = jest.fn();

jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: jest.fn(async () => ({})),
  sendOwedCohostEmails: jest.fn(async () => undefined),
}));
jest.mock("../../lib/compliance/erasure/mail-footprint", () => ({
  scrubMailFootprintTx: jest.fn(),
}));
jest.mock("../../lib/digital-products/erasure", () => ({
  scrubDigitalProductsTx: jest.fn(async () => []),
  purgeErasedCreatorFiles: jest.fn(async () => []),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const mockClient = {
  $queryRaw: jest.fn(async () => [{ ready: true }]),
  $executeRaw: jest.fn(),
  // The ended row is no longer on the team, so the drive goes ahead.
  collaborator: { findFirst: jest.fn(async () => null) },
  streamRevocationRetry: mockRetryTable,
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockClient;
  },
}));
jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: (...args: unknown[]) => mockDrive(...args),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({}));
jest.mock("../../lib/stream/dm-eligibility", () => ({}));
jest.mock("../../lib/stream/conduct-call-block", () => ({}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  isExpectedStreamError: jest.fn(() => false),
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken: jest.fn(async () => ({})),
    deleteUsers: jest.fn(async () => ({})),
  })),
}));

import { scrubUser } from "@/lib/compliance/erasure/scrub-user";
import { supportScrubModels } from "../fixtures/support-erasure-models";

const none = () => jest.fn(async () => ({ count: 0 }));
const mockRequest = jest.fn();
const tx = {
  ...supportScrubModels(),
  user: { update: jest.fn(async () => ({})) },
  // The scrub re-reads the user's bookings on its own transaction: none hosted, none held.
  consultantProfile: {
    updateMany: none(),
    findUnique: jest.fn(async () => ({ userId: "u1" })),
    findFirst: jest.fn(async () => null),
  },
  consulteeProfile: { updateMany: none() },
  trial: { updateMany: none(), count: jest.fn(async () => 0) },
  consultation: { updateMany: none(), count: jest.fn(async () => 0) },
  subscription: { count: jest.fn(async () => 0) },
  appointment: { count: jest.fn(async () => 0) },
  collaborator: {
    findMany: jest.fn(async () => [{ id: "c-1" }]),
    updateManyAndReturn: jest.fn(async () => [
      {
        id: "c-1",
        consultantProfileId: "cp-1",
        webinarPlanId: "wp-1",
        classPlanId: null,
        status: "REMOVED",
        acceptedAt: new Date("2026-11-01T00:00:00Z"),
      },
    ]),
  },
  session: { findMany: jest.fn(async () => []), deleteMany: none() },
  sessionAccessLog: { updateMany: none() },
  $queryRaw: jest.fn(async () => [{ ready: true }]),
  account: { deleteMany: none() },
  erasureRequest: { findFirst: mockRequest },
  streamRevocationRetry: mockRetryTable,
};
const db = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "u1",
      erasedAt: null,
      pseudonymousId: null,
    })),
  },
  membership: { findMany: jest.fn(async () => []) },
  payoutAccount: { findMany: jest.fn(async () => []) },
  streamRevocationRetry: mockRetryTable,
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

beforeEach(() => {
  jest.clearAllMocks();
  retryRows = [];
  mockDrive.mockResolvedValue("1 of 2 event channels not left");
});

describe("the revocation an erased co-host leaves owed", () => {
  it("is the collaborator intent, still owed after a failed attempt, when no erasure request is being processed", async () => {
    mockRequest.mockResolvedValue(null);

    await scrubUser(db as never, "u1");

    expect(retryRows).toEqual([
      expect.objectContaining({
        kind: "COLLAB_REVOKE",
        userId: "u1",
        planId: "wp-1",
        planType: "WEBINAR",
        status: "PENDING",
      }),
    ]);
    expect(mockDrive).toHaveBeenCalledTimes(1);
  });

  it("is the erasure request's outbox row alone when a request is being processed", async () => {
    mockRequest.mockResolvedValue({ id: "er-1" });

    await scrubUser(db as never, "u1");

    expect(retryRows.map((row) => [row.erasureRequestId, row.planId])).toEqual([
      ["er-1", "wp-1"],
      ["er-1", "principal:u1"],
    ]);
    expect(retryRows.some((row) => row.kind === "COLLAB_REVOKE")).toBe(false);
  });
});
