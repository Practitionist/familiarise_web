/**
 * @jest-environment node
 */

/**
 * #1270 — a moderation action whose Stream write failed was never retried.
 *
 * The failure was recorded in `ModerationAction.sideEffects` and left there:
 * the action route's 409 idempotency guard, which is what stops a double
 * refund, also blocks the only path that could have re-run the Stream step. So
 * a ban taken while Stream was down stayed unenforced on Stream until somebody
 * happened to read the JSON.
 *
 * The sweep drains exactly the rows whose recorded outcome says "failed". What
 * it must never do is re-enforce a ban that has since been lifted.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// reportSentryError and the shared loggers capture through @sentry/core; share the one mock.
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationAction: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () => ({ banned: true, banExpires: null })),
    },
    // #1593 — the sweep also drains the erasure revocation outbox.
    streamRevocationRetry: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    vendorErasureRetry: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    erasureRequest: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $disconnect: jest.fn(async () => undefined),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  CronLockHeldError: class extends Error {},
}));

jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));

jest.mock("../../lib/stream/access-revocation", () => ({
  redriveAccessRevocation: jest.fn(async () => null),
}));

jest.mock("../../lib/moderation/side-effects", () => ({
  __esModule: true,
  applyStreamEnforcement: jest.fn(async () => undefined),
  restoreStreamAccess: jest.fn(async () => undefined),
  streamErrorPrefix: (actionType: string) =>
    actionType === "CONTENT_REMOVED" ? "message-delete" : "stream",
}));

import { retryModerationEnforcement } from "../../scripts/cleanup/retry-moderation-enforcement";
import prisma from "../../lib/prisma";
import { applyStreamEnforcement } from "../../lib/moderation/side-effects";
import { revokeCollaboratorAccess } from "../../lib/collaborators/service";
import * as Sentry from "@sentry/nextjs";

const findMany = prisma.moderationAction.findMany as jest.Mock;
const update = prisma.moderationAction.update as jest.Mock;
const outboxFindMany = prisma.streamRevocationRetry.findMany as jest.Mock;
const outboxUpdate = prisma.streamRevocationRetry.update as jest.Mock;
const outboxCount = prisma.streamRevocationRetry.count as jest.Mock;
const vendorOutboxFindMany = prisma.vendorErasureRetry.findMany as jest.Mock;
const vendorOutboxUpdate = prisma.vendorErasureRetry.update as jest.Mock;
const erasureRequestUpdateMany = prisma.erasureRequest.updateMany as jest.Mock;
const findUser = prisma.user.findUnique as jest.Mock;
const enforce = applyStreamEnforcement as jest.Mock;
const revokeCollaboratorAccessMock = revokeCollaboratorAccess as jest.Mock;

const failedBan = (overrides: Record<string, unknown> = {}) => ({
  id: "action-1",
  actionType: "USER_BANNED",
  createdAt: new Date(),
  sideEffects: {
    stream: "failed",
    streamAttempts: 1,
    errors: ["stream: down"],
  },
  report: {
    id: "r1",
    type: "PROFILE",
    targetUserId: "u1",
    reviewId: null,
    streamMessageId: null,
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  findUser.mockResolvedValue({ banned: true, banExpires: null });
  enforce.mockResolvedValue(undefined);
  outboxFindMany.mockResolvedValue([]);
  vendorOutboxFindMany.mockResolvedValue([]);
  // `clearMocks` clears call records, not implementations, so the delegates
  // are re-pinned here so a later case cannot inherit an override.
  outboxCount.mockResolvedValue(0);
  outboxUpdate.mockResolvedValue({});
  revokeCollaboratorAccessMock.mockResolvedValue({ success: true });
});

describe("retryModerationEnforcement", () => {
  it("selects only the actions whose recorded Stream or collaborator outcome failed", async () => {
    await retryModerationEnforcement();

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      OR: [
        { sideEffects: { path: ["stream"], equals: "failed" } },
        { sideEffects: { path: ["collaboratorRevocation"], equals: "failed" } },
      ],
    });
  });

  // #1580 — a failed per-plan Stream revocation is re-driven from the same
  // queue, and the user-level step is left alone when it did not fail.
  it("re-drives a failed collaborator revocation without touching a landed Stream step", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({
        sideEffects: {
          stream: "ok",
          collaboratorRevocation: "failed",
          collaborationsRemoved: [{ planType: "webinar", planId: "wp-1" }],
          errors: ["collaborator-revoke: webinar:wp-1"],
        },
      }),
    ]);

    const result = await retryModerationEnforcement();

    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "webinar",
      "wp-1",
      "u1",
      { notify: false },
    );
    expect(enforce).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.sideEffects).toMatchObject({
      stream: "ok",
      collaboratorRevocation: "ok",
      collaboratorRevocationAttempts: 2,
    });
    expect(result.collaboratorRecovered).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it("re-drives the ban and records that it landed", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);

    const result = await retryModerationEnforcement();

    expect(enforce).toHaveBeenCalledWith(
      "USER_BANNED",
      expect.objectContaining({ targetUserId: "u1" }),
    );
    expect(update.mock.calls[0][0].data.sideEffects).toMatchObject({
      stream: "ok",
      streamAttempts: 2,
    });
    expect(result.recovered).toBe(1);
  });

  it("never re-enforces a ban that was lifted while the retry was owed", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);
    findUser.mockResolvedValue({ banned: false, banExpires: null });

    const result = await retryModerationEnforcement();

    expect(enforce).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.sideEffects.stream).toBe("skipped");
    expect(result.skipped).toBe(1);
  });

  it("treats an expired suspension as no longer enforceable", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({ actionType: "USER_SUSPENDED" }),
    ]);
    findUser.mockResolvedValue({
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    });

    const result = await retryModerationEnforcement();

    expect(enforce).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps the row queued and counts the attempt when the retry fails too", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);
    enforce.mockRejectedValueOnce(new Error("still down"));

    const result = await retryModerationEnforcement();

    const written = update.mock.calls[0][0].data.sideEffects;
    expect(written.stream).toBe("failed");
    expect(written.streamAttempts).toBe(2);
    expect(written.errors).toHaveLength(2);
    expect(result.stillFailing).toBe(1);
  });

  it("gives up terminally once the attempt budget is spent", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({
        sideEffects: { stream: "failed", streamAttempts: 6 },
      }),
    ]);

    const result = await retryModerationEnforcement({ maxAttempts: 6 });

    expect(enforce).not.toHaveBeenCalled();
    // A different value, so a capped row drops out of the selector by
    // construction rather than by a negated JSON filter.
    expect(update.mock.calls[0][0].data.sideEffects.stream).toBe("gave_up");
    expect(result.gaveUp).toBe(1);
  });

  it("gives up on a row too old for a retry to mean anything", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({ createdAt: new Date(Date.now() - 100 * 3_600_000) }),
    ]);

    const result = await retryModerationEnforcement({ giveUpAfterHours: 72 });

    expect(result.gaveUp).toBe(1);
    expect(enforce).not.toHaveBeenCalled();
  });

  it("re-drives the message delete for a CONTENT_REMOVED action", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({
        actionType: "CONTENT_REMOVED",
        report: {
          id: "r2",
          type: "MESSAGE",
          targetUserId: "u1",
          reviewId: null,
          streamMessageId: "msg-1",
          streamChannelCid: "messaging:chan-1",
        },
      }),
    ]);

    const result = await retryModerationEnforcement();

    expect(enforce).toHaveBeenCalledWith(
      "CONTENT_REMOVED",
      expect.objectContaining({
        streamMessageId: "msg-1",
        // The cid travels with the id — the delete needs both, and asserting
        // only the id passed while the sweep forwarded neither.
        streamChannelCid: "messaging:chan-1",
      }),
    );
    // The ban state is irrelevant to a message delete, so it is not consulted.
    expect(findUser).not.toHaveBeenCalled();
    expect(result.recovered).toBe(1);
  });

  it("drains the erasure revocation outbox and marks a landed row SUCCEEDED (#1593)", async () => {
    findMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValue([
      {
        id: "retry-1",
        kind: "ERASURE_REVOKE",
        erasureRequestId: "er-1",
        planType: "CLASS",
        planId: "cp-9",
        attempts: 1,
        erasureRequest: { userId: "u-erased" },
      },
    ]);

    const result = await retryModerationEnforcement();

    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "class",
      "cp-9",
      "u-erased",
      { notify: false },
    );
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "retry-1" },
      data: { status: "SUCCEEDED", attempts: 2, completedAt: expect.any(Date) },
    });
    expect(erasureRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "er-1", status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    expect(result.erasureRevocationsRecovered).toBe(1);
    expect(result.success).toBe(true);
  });

  it("re-drives a queued cancellation revocation by kind, capped by attempts", async () => {
    const { redriveAccessRevocation } = jest.requireMock(
      "../../lib/stream/access-revocation",
    ) as { redriveAccessRevocation: jest.Mock };
    findMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValueOnce([
      {
        id: "retry-dm",
        kind: "DM_REMOVE",
        erasureRequestId: null,
        erasureRequest: null,
        userId: "client-1",
        counterpartUserId: "host-1",
        planType: null,
        planId: "dm-client-1-host-1",
        attempts: 0,
        createdAt: new Date(),
      },
    ]);

    const result = await retryModerationEnforcement();

    expect(outboxFindMany.mock.calls[0][0].where.attempts).toEqual({ lt: 6 });
    expect(redriveAccessRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "DM_REMOVE", userId: "client-1" }),
    );
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "retry-dm" },
      data: { status: "SUCCEEDED", attempts: 1, completedAt: expect.any(Date) },
    });
    expect(result.accessRevocationsRecovered).toBe(1);
    expect(erasureRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("drains VendorErasureRetry rows and finalizes IN_PROGRESS ErasureRequest when all outbox legs succeed", async () => {
    findMany.mockResolvedValue([]);
    vendorOutboxFindMany.mockResolvedValueOnce([
      {
        id: "vr-1",
        erasureRequestId: "er-vendor-1",
        vendor: "RAZORPAY",
        vendorRef: "u-erased",
        payload: { customerId: null, payoutAccounts: [] },
        attempts: 1,
        erasureRequest: { userId: "u-erased" },
      },
    ]);

    const result = await retryModerationEnforcement();

    expect(vendorOutboxUpdate).toHaveBeenCalledWith({
      where: { id: "vr-1" },
      data: { status: "SUCCEEDED", attempts: 2, completedAt: expect.any(Date) },
    });
    expect(erasureRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "er-vendor-1", status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    expect(result.erasureRevocationsRecovered).toBe(1);
    expect(result.success).toBe(true);
  });

  it("never selects a Stream erasure row that already spent its attempt budget", async () => {
    await retryModerationEnforcement();

    expect(outboxFindMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ["PENDING", "FAILED"] },
      attempts: { lt: 6 },
    });
    // The vendor leg already carried the cap; the two legs must agree.
    expect(vendorOutboxFindMany.mock.calls[0][0].where).toMatchObject({
      attempts: { lt: 6 },
    });
  });

  it("gives up on a Stream erasure row once, reports it once and leaves it terminal", async () => {
    findMany.mockResolvedValue([]);
    const capped = {
      id: "retry-1",
      kind: "ERASURE_REVOKE",
      userId: null,
      counterpartUserId: null,
      erasureRequestId: "er-1",
      planType: "CLASS",
      planId: "cp-9",
      attempts: 5,
      erasureRequest: { userId: "u-erased" },
    };
    // A row leaves the cohort once its budget is spent, so the mock has to
    // honour the cap the way the database does: the write bumps the very
    // attempts the next read filters on.
    outboxFindMany.mockImplementation(
      async ({ where }: { where: { attempts?: { lt?: number } } }) => {
        const cap = where.attempts?.lt;
        return cap === undefined || capped.attempts < cap ? [capped] : [];
      },
    );
    outboxUpdate.mockImplementation(
      async ({ data }: { data: { attempts: number } }) => {
        capped.attempts = data.attempts;
        return {};
      },
    );
    // The row keeps failing, the way a permanently broken leg does.
    revokeCollaboratorAccessMock.mockRejectedValue(new Error("stream down"));

    const first = await retryModerationEnforcement();

    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "retry-1" },
      data: {
        status: "FAILED",
        attempts: 6,
        lastError: "stream down",
        nextRetryAt: null,
      },
    });
    expect(first.gaveUp).toBe(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // The next tick: the row is at its budget, so it is neither re-driven nor
    // re-reported.
    const second = await retryModerationEnforcement();

    expect(outboxUpdate).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(second.gaveUp).toBe(0);
    expect(second.success).toBe(true);
  });

  it("keeps the erasure request open while a leg is still outstanding", async () => {
    findMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValue([
      {
        id: "retry-ok",
        kind: "ERASURE_REVOKE",
        userId: null,
        counterpartUserId: null,
        erasureRequestId: "er-1",
        planType: "CLASS",
        planId: "cp-1",
        attempts: 1,
        erasureRequest: { userId: "u-erased" },
      },
    ]);
    // Another leg of this request is capped, so it is still outstanding: an
    // unconfirmed processor copy must not be counted as a completed erasure.
    outboxCount.mockResolvedValue(1);

    await retryModerationEnforcement();

    // The count that gates completion carries no attempts filter, so a capped
    // leg is still outstanding and the request must not be completed.
    expect(outboxCount).toHaveBeenCalledWith({
      where: {
        erasureRequestId: "er-1",
        status: { in: ["PENDING", "FAILED"] },
      },
    });
    expect(erasureRequestUpdateMany).not.toHaveBeenCalled();
  });
});
