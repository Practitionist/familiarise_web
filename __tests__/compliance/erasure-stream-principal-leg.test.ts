/**
 * @jest-environment node
 */

jest.mock("../../lib/compliance/erasure/mail-footprint", () => ({
  scrubMailFootprintTx: jest.fn(),
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
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/stream/recording-stream-delete", () => ({
  deleteStreamRecordingCopy: jest.fn(async () => ({ success: true })),
}));

const mockPurge = jest.fn();
const mockPurgeProduct = jest.fn();
jest.mock("../../lib/data/public-cache", () => ({
  purgeRecordingSurfaces: (slugs: string[]) => mockPurge(slugs),
  purgeDigitalProductSurfaces: (p: unknown) => mockPurgeProduct(p),
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
import { supportScrubModels } from "../fixtures/support-erasure-models";

const tx = {
  ...supportScrubModels(),
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
  appointmentWaitlist: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  windowBackupInterest: { deleteMany: jest.fn(async () => ({ count: 0 })) },
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
  ...supportScrubModels(),
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
    const mockRecordingFindMany = jest.fn(async () => [{ id: "rec-1on1" }]);
    const mockRecordingClaim = jest.fn(async () => [
      {
        id: "rec-1on1",
        storagePath: null,
        previewClipStoragePath: null,
        streamCallId: null,
        streamRecordingId: null,
        removedAt: null,
      },
    ]);
    const mockRecordingUpdateMany = jest.fn(async () => ({ count: 1 }));
    const mockRecordingConsentUpdateMany = jest.fn(async () => ({ count: 1 }));

    const dbWithRecordings = {
      ...db,
      recording: {
        findMany: mockRecordingFindMany,
        updateManyAndReturn: mockRecordingClaim,
        updateMany: mockRecordingUpdateMany,
      },
      recordingConsent: {
        updateMany: mockRecordingConsentUpdateMany,
      },
    };

    await scrubUser(dbWithRecordings as never, "u-erased-1");

    expect(mockRecordingFindMany).toHaveBeenCalled();
    expect(mockRecordingClaim).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "rec-1on1",
        status: { not: "EXPIRED" },
        OR: [
          { status: { not: "EXPIRED" } },
          {
            status: "EXPIRED",
            OR: [
              { storagePath: { not: null } },
              { previewClipStoragePath: { not: null } },
              { streamRecordingId: { not: null } },
            ],
          },
        ],
        purchases: { none: {} },
      }),
      data: {
        status: "EXPIRED",
        recordingUrl: "",
        removedAt: expect.any(Date),
      },
      select: {
        id: true,
        storagePath: true,
        previewClipStoragePath: true,
        streamCallId: true,
        streamRecordingId: true,
        removedAt: true,
      },
    });
    expect(mockRecordingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "rec-1on1",
        status: "EXPIRED",
        storagePath: null,
        previewClipStoragePath: null,
        streamRecordingId: null,
      },
      data: {
        storagePath: null,
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        previewTranscript: null,
        thumbnailUrl: null,
        streamRecordingId: null,
        removedAt: expect.any(Date),
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

describe("erasure purges the public replays cache", () => {
  const replays = {
    findMany: jest.fn(async (args: { select: Record<string, boolean> }) =>
      args.select.slug ? [{ slug: "intro" }, { slug: "advanced" }] : [],
    ),
    updateMany: jest.fn(async () => ({ count: 2 })),
  };
  const dbWithReplays = {
    ...db,
    recording: replays,
    recordingConsent: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };

  it("purges once with the unpublished slugs after a successful scrub", async () => {
    await scrubUser(dbWithReplays as never, "u-erased-1");

    expect(replays.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledWith(["intro", "advanced"]);
  });

  it("does not purge when the scrub transaction throws", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("tx failed"));

    await expect(
      scrubUser(dbWithReplays as never, "u-erased-1"),
    ).rejects.toThrow("tx failed");
    expect(replays.updateMany).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("purges each archived product after commit, even with no replays", async () => {
    (tx.digitalProduct.findMany as jest.Mock).mockResolvedValueOnce([
      { consultantProfileId: "cp1", slug: "pack" },
    ]);
    replays.findMany.mockResolvedValue([]);

    await scrubUser(dbWithReplays as never, "u-erased-1");

    expect(mockPurgeProduct).toHaveBeenCalledTimes(1);
    expect(mockPurgeProduct).toHaveBeenCalledWith({
      consultantProfileId: "cp1",
      slug: "pack",
    });
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("does not purge products when the transaction throws", async () => {
    (tx.digitalProduct.findMany as jest.Mock).mockResolvedValueOnce([
      { consultantProfileId: "cp1", slug: "pack" },
    ]);
    db.$transaction.mockRejectedValueOnce(new Error("tx failed"));

    await expect(
      scrubUser(dbWithReplays as never, "u-erased-1"),
    ).rejects.toThrow();
    expect(mockPurgeProduct).not.toHaveBeenCalled();
  });
});
