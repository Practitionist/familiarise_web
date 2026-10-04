/**
 * @jest-environment node
 */

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({}),
}));
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: jest.fn(async () => true),
}));

const mockRevokeUserToken = jest.fn(async () => ({}));
const mockDeleteUsers = jest.fn(async () => ({}));
let mockStreamConfigured = true;

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => mockStreamConfigured,
  isExpectedStreamError: (err: unknown) =>
    Boolean(
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 16,
    ),
  getStreamChatClient: () => ({
    revokeUserToken: mockRevokeUserToken,
    deleteUsers: mockDeleteUsers,
  }),
}));

import {
  eraseStreamPrincipalFootprint,
  principalStreamPlanId,
  scrubUser,
} from "@/lib/compliance/erasure/scrub-user";

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: null })),
  },
  consultantProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
  consulteeProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
  trial: { updateMany: jest.fn(async () => ({ count: 0 })) },
  consultation: { updateMany: jest.fn(async () => ({ count: 0 })) },
  collaborator: { updateManyAndReturn: jest.fn(async () => []) },
  session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  erasureRequest: {
    findFirst: jest.fn(async () => ({ id: "er-principal-1" })),
  },
  streamRevocationRetry: { createMany: jest.fn(async () => ({ count: 1 })) },
};

const db = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "u-erased-1",
      erasedAt: null,
      pseudonymousId: null,
      razorpayCustomerId: null,
    })),
  },
  membership: { findMany: jest.fn(async () => []) },
  payoutAccount: { findMany: jest.fn(async () => []) },
  streamRevocationRetry: { update: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStreamConfigured = true;
  mockRevokeUserToken.mockResolvedValue({});
  mockDeleteUsers.mockResolvedValue({});
});

describe("DPDP erasure Stream principal leg", () => {
  it("hard-deletes the Stream user and messages and settles the principal outbox row SUCCEEDED", async () => {
    const result = await scrubUser(db as never, "u-erased-1");

    expect(result.scrubbed).toBe(true);
    expect(tx.streamRevocationRetry.createMany).toHaveBeenCalledWith({
      data: [
        {
          erasureRequestId: "er-principal-1",
          planType: "WEBINAR",
          planId: principalStreamPlanId("u-erased-1"),
        },
      ],
      skipDuplicates: true,
    });
    expect(mockRevokeUserToken).toHaveBeenCalledWith(
      "u-erased-1",
      expect.any(Date),
    );
    expect(mockDeleteUsers).toHaveBeenCalledWith(["u-erased-1"], {
      user: "hard",
      messages: "hard",
    });
    expect(db.streamRevocationRetry.update).toHaveBeenCalledWith({
      where: {
        erasureRequestId_planType_planId: {
          erasureRequestId: "er-principal-1",
          planType: "WEBINAR",
          planId: "principal:u-erased-1",
        },
      },
      data: {
        status: "SUCCEEDED",
        attempts: 1,
        completedAt: expect.any(Date),
      },
    });
  });

  it("schedules a retry backoff slot when Stream hard-delete fails during scrubUser", async () => {
    mockDeleteUsers.mockRejectedValueOnce(new Error("Stream 429 rate limit"));

    await scrubUser(db as never, "u-erased-1");

    expect(db.streamRevocationRetry.update).toHaveBeenCalledWith({
      where: {
        erasureRequestId_planType_planId: {
          erasureRequestId: "er-principal-1",
          planType: "WEBINAR",
          planId: "principal:u-erased-1",
        },
      },
      data: {
        status: "FAILED",
        attempts: 1,
        lastError: "Stream 429 rate limit",
        nextRetryAt: expect.any(Date),
      },
    });
  });

  it("treats Stream code 16 (already deleted) as idempotent success in eraseStreamPrincipalFootprint", async () => {
    mockDeleteUsers.mockRejectedValueOnce(
      Object.assign(new Error("User not found"), { code: 16 }),
    );

    await expect(
      eraseStreamPrincipalFootprint("u-erased-1"),
    ).resolves.toBeUndefined();
  });

  it("purges 1:1 recordings, unpublishes host group recordings, and withdraws RecordingConsent on scrubUser", async () => {
    const mockRecordingFindMany = jest.fn(async () => [
      {
        id: "rec-1on1",
        storagePath: null,
        previewClipStoragePath: null,
      },
    ]);
    const mockRecordingUpdate = jest.fn(async () => ({}));
    const mockRecordingUpdateMany = jest.fn(async () => ({ count: 1 }));
    const mockRecordingConsentUpdateMany = jest.fn(async () => ({ count: 1 }));

    const dbWithRecordings = {
      ...db,
      recording: {
        findMany: mockRecordingFindMany,
        update: mockRecordingUpdate,
        updateMany: mockRecordingUpdateMany,
      },
      recordingConsent: {
        updateMany: mockRecordingConsentUpdateMany,
      },
    };

    await scrubUser(dbWithRecordings as never, "u-erased-1");

    expect(mockRecordingFindMany).toHaveBeenCalled();
    expect(mockRecordingUpdate).toHaveBeenCalledWith({
      where: { id: "rec-1on1" },
      data: {
        status: "EXPIRED",
        recordingUrl: "",
        storageUrl: null,
        storagePath: null,
        previewClipUrl: null,
        previewClipStoragePath: null,
      },
    });
    expect(mockRecordingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ listingStatus: "PUBLISHED" }),
        data: {
          listingStatus: "UNPUBLISHED",
          unpublishedAt: expect.any(Date),
        },
      }),
    );
    expect(mockRecordingConsentUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u-erased-1", decision: "GRANTED" },
      data: { decision: "DECLINED", decidedAt: expect.any(Date) },
    });
  });
});
