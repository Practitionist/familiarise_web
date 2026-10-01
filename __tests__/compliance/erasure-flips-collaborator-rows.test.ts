/**
 * @jest-environment node
 */

/**
 * #1580 — an erased consultant used to stay an ACCEPTED collaborator in every
 * split and roster. The scrub now runs the same flip the moderation ban runs
 * inside its transaction and revokes Stream access per plan after commit.
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

import { revokeCollaboratorAccess } from "@/lib/collaborators/service";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
  },
  consultantProfile: { updateMany: jest.fn(async () => ({ count: 1 })) },
  // #1598 P4-P0-05 — the consultee free-text scrub runs in the same tx.
  consulteeProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
  trial: { updateMany: jest.fn(async () => ({ count: 0 })) },
  consultation: { updateMany: jest.fn(async () => ({ count: 0 })) },
  collaborator: {
    updateManyAndReturn: jest.fn(async () => [
      { collaboratorType: "WEBINAR", webinarPlanId: "wp-1", classPlanId: null },
    ]),
  },
  session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  // #1593 — the outbox: the request being processed and the rows the scrub
  // writes for it inside the transaction.
  erasureRequest: { findFirst: jest.fn(async () => ({ id: "er-1" })) },
  streamRevocationRetry: { createMany: jest.fn(async () => ({ count: 1 })) },
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
  streamRevocationRetry: { update: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

beforeEach(() => jest.clearAllMocks());

describe("DPDP erasure flips collaborator rows", () => {
  it("moves PENDING/ACCEPTED rows to REMOVED in the transaction and revokes each plan after it", async () => {
    const result = await scrubUser(db as never, "u1");

    expect(result.scrubbed).toBe(true);
    expect(tx.collaborator.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consultantProfileId: "cp-1",
          status: { in: ["PENDING", "ACCEPTED"] },
        },
        data: { status: "REMOVED", respondedAt: expect.any(Date) },
      }),
    );
    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "webinar",
      "wp-1",
      "u1",
      { notify: false },
    );
  });

  it("writes the outbox row inside the transaction and settles it after the attempt (#1593)", async () => {
    // The revocation fails this time: the row was already durable before the
    // attempt, and is left FAILED with its first retry slot for the sweep.
    (revokeCollaboratorAccess as jest.Mock).mockResolvedValueOnce({
      success: false,
    });

    await scrubUser(db as never, "u1");

    expect(tx.streamRevocationRetry.createMany).toHaveBeenCalledWith({
      data: [{ erasureRequestId: "er-1", planType: "WEBINAR", planId: "wp-1" }],
      skipDuplicates: true,
    });
    expect(db.streamRevocationRetry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          erasureRequestId_planType_planId: {
            erasureRequestId: "er-1",
            planType: "WEBINAR",
            planId: "wp-1",
          },
        },
        data: expect.objectContaining({
          status: "FAILED",
          attempts: 1,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });
});
