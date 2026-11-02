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
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/stream/recording-stream-delete", () => ({
  deleteStreamRecordingCopy: jest.fn(async () => ({ success: true })),
}));

const mockPurge = jest.fn();
jest.mock("../../lib/data/public-cache", () => ({
  purgeRecordingSurfaces: (slugs: string[]) => mockPurge(slugs),
}));

const mockRevokeUserToken = jest.fn(async () => ({}));
const mockDeleteUsers = jest.fn(async () => ({}));
const mockStreamConfigured = true;

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

import { scrubUser } from "@/lib/compliance/erasure/scrub-user";
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
  recording: {
    findMany: jest.fn(async (args: { select: Record<string, boolean> }) =>
      args.select.slug ? [{ slug: "intro" }, { slug: "advanced" }] : [],
    ),
    updateMany: jest.fn(async () => ({ count: 2 })),
  },
  recordingConsent: { updateMany: jest.fn(async () => ({ count: 0 })) },
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("erasure purges the public replays cache", () => {
  it("purges once with the unpublished slugs after a successful scrub", async () => {
    await scrubUser(db as never, "u-erased-1");

    expect(db.recording.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledWith(["intro", "advanced"]);
  });

  it("does not purge when the scrub transaction throws", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("tx failed"));

    await expect(scrubUser(db as never, "u-erased-1")).rejects.toThrow(
      "tx failed",
    );
    expect(db.recording.updateMany).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });
});
