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

const mockReportStandingFinding = jest.fn(
  async (_args: { key: string }, report?: () => void) => {
    report?.();
    return true;
  },
);
jest.mock("../../lib/observability/standing-finding", () => ({
  reportStandingFinding: (args: { key: string }, report?: () => void) =>
    mockReportStandingFinding(args, report),
}));

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
    consultantProfile: { findUnique: jest.fn(async () => null) },
    // #1593 — the sweep also drains the erasure revocation outbox.
    streamRevocationRetry: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
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

jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: jest.fn(async () => null),
}));

let mockStreamConfigured = true;
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => mockStreamConfigured,
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
import { driveCollaboratorRevocation } from "../../lib/stream/collaborator-access";
import { redriveAccessRevocation } from "../../lib/stream/access-revocation";
import * as Sentry from "@sentry/nextjs";

const findMany = prisma.moderationAction.findMany as jest.Mock;
const update = prisma.moderationAction.update as jest.Mock;
const outboxFindMany = prisma.streamRevocationRetry.findMany as jest.Mock;
const outboxUpdate = prisma.streamRevocationRetry.update as jest.Mock;
const outboxUpdateMany = prisma.streamRevocationRetry.updateMany as jest.Mock;
const outboxCount = prisma.streamRevocationRetry.count as jest.Mock;
const vendorOutboxFindMany = prisma.vendorErasureRetry.findMany as jest.Mock;
const vendorOutboxUpdate = prisma.vendorErasureRetry.update as jest.Mock;
const vendorOutboxCount = prisma.vendorErasureRetry.count as jest.Mock;
const erasureRequestUpdateMany = prisma.erasureRequest.updateMany as jest.Mock;
const findUser = prisma.user.findUnique as jest.Mock;
const enforce = applyStreamEnforcement as jest.Mock;
const driveCollaboratorRevocationMock =
  driveCollaboratorRevocation as jest.Mock;
const redrive = redriveAccessRevocation as jest.Mock;

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
  mockStreamConfigured = true;
  findUser.mockResolvedValue({ banned: true, banExpires: null });
  enforce.mockResolvedValue(undefined);
  outboxFindMany.mockResolvedValue([]);
  vendorOutboxFindMany.mockResolvedValue([]);
  // `clearMocks` clears call records, not implementations, so the delegates
  // are re-pinned here so a later case cannot inherit an override.
  outboxCount.mockResolvedValue(0);
  outboxUpdate.mockResolvedValue({});
  outboxUpdateMany.mockResolvedValue({ count: 1 });
  driveCollaboratorRevocationMock.mockResolvedValue(null);
});

describe("retryModerationEnforcement", () => {
  it("selects only the actions whose recorded Stream, collaborator or unpaid-sales outcome failed", async () => {
    await retryModerationEnforcement();

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      OR: [
        {
          actionType: {
            in: [
              "USER_BANNED",
              "USER_SUSPENDED",
              "CONTENT_REMOVED",
              "USER_REINSTATED",
            ],
          },
          OR: [
            { sideEffects: { path: ["stream"], equals: "failed" } },
            {
              sideEffects: {
                path: ["collaboratorRevocation"],
                equals: "failed",
              },
            },
          ],
        },
        {
          actionType: "PROFILE_UNVERIFIED",
          sideEffects: { path: ["unpaidSales"], equals: "failed" },
        },
      ],
    });
  });

  it("stops starting action rows once its share of the run is spent, so the Stream drain still starts", async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    findMany.mockResolvedValueOnce([
      failedBan(),
      failedBan({ id: "action-2" }),
    ]);
    outboxFindMany.mockResolvedValueOnce([
      {
        id: "revoke-1",
        kind: "SEAT_ACCESS_REVOKE",
        erasureRequestId: null,
        userId: "u9",
        counterpartUserId: null,
        planType: "WEBINAR",
        planId: "wp-9",
        attempts: 0,
        nextRetryAt: null,
        createdAt: new Date(),
        erasureRequest: null,
      },
    ]);
    enforce.mockImplementationOnce(async () => {
      now += 9_000;
    });
    try {
      await retryModerationEnforcement();
    } finally {
      clock.mockRestore();
    }

    expect(enforce).toHaveBeenCalledTimes(1);
    // The drain still starts its due row in the time the action rows left it.
    expect(redrive).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "SEAT_ACCESS_REVOKE", userId: "u9" }),
      expect.anything(),
    );
    expect(outboxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "revoke-1" }),
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
  });

  it("records a failed standing read for one ending and goes on to the next row", async () => {
    (prisma.consultantProfile.findUnique as jest.Mock).mockRejectedValueOnce(
      new Error("pool timeout"),
    );
    findMany.mockResolvedValueOnce([
      failedBan({
        id: "reject-1",
        actionType: "PROFILE_UNVERIFIED",
        sideEffects: {
          unpaidSales: "failed",
          unpaidSalesAttempts: 1,
          unverifiedConsultantProfileId: "cp-1",
        },
      }),
      failedBan({ id: "action-2" }),
    ]);

    const result = await retryModerationEnforcement();

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("pool timeout")]),
    );
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reject-1" } }),
    );
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

    expect(driveCollaboratorRevocation).toHaveBeenCalledWith(
      { planType: "webinar", planId: "wp-1" },
      "u1",
      Number.POSITIVE_INFINITY,
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

    expect(driveCollaboratorRevocation).toHaveBeenCalledWith(
      { planType: "class", planId: "cp-9" },
      "u-erased",
      Number.POSITIVE_INFINITY,
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
        nextRetryAt: null,
        createdAt: new Date(),
      },
    ]);

    const result = await retryModerationEnforcement();

    expect(outboxFindMany.mock.calls[0][0].where.AND[0]).toEqual({
      OR: [
        { attempts: { lt: 6 } },
        {
          kind: {
            in: [
              "SEAT_ACCESS_REVOKE",
              "REFUND_ACCESS_REVOKE",
              "ERASURE_REVOKE",
              "CONDUCT_CALL_BLOCK",
              "COLLAB_REVOKE",
            ],
          },
        },
      ],
    });
    expect(redriveAccessRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "DM_REMOVE", userId: "client-1" }),
      { deadlineMs: expect.any(Number) },
    );
    expect(outboxUpdateMany).toHaveBeenCalledWith({
      where: { id: "retry-dm", attempts: 0, nextRetryAt: null },
      data: { status: "SUCCEEDED", attempts: 1, completedAt: expect.any(Date) },
    });
    expect(outboxUpdate).not.toHaveBeenCalled();
    expect(result.accessRevocationsRecovered).toBe(1);
    expect(erasureRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("stops starting revocation rows once the run deadline passes, and bounds the row in flight by it", async () => {
    const { redriveAccessRevocation } = jest.requireMock(
      "../../lib/stream/access-revocation",
    ) as { redriveAccessRevocation: jest.Mock };
    let now = 5_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    findMany.mockResolvedValue([]);
    const seatRow = (id: string) => ({
      id,
      kind: "SEAT_ACCESS_REVOKE",
      erasureRequestId: null,
      erasureRequest: null,
      userId: "attendee-1",
      counterpartUserId: null,
      planType: null,
      planId: "appt-1",
      attempts: 0,
      nextRetryAt: new Date(4_000_000),
      createdAt: new Date(),
    });
    outboxFindMany.mockResolvedValueOnce([
      seatRow("retry-a"),
      seatRow("retry-b"),
    ]);
    redriveAccessRevocation.mockImplementationOnce(async () => {
      now += 17_000;
      return "time budget spent before call removal";
    });

    try {
      await retryModerationEnforcement();
    } finally {
      clock.mockRestore();
    }

    expect(redriveAccessRevocation).toHaveBeenCalledTimes(1);
    expect(redriveAccessRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "SEAT_ACCESS_REVOKE" }),
      { deadlineMs: 5_000_000 + 16_000 },
    );
    expect(outboxUpdateMany).toHaveBeenCalledTimes(1);
    expect(outboxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "retry-a",
          attempts: 0,
          nextRetryAt: new Date(4_000_000),
        },
      }),
    );
  });

  it("does not start a seat or refund row with less than its minimum slice left", async () => {
    const { redriveAccessRevocation } = jest.requireMock(
      "../../lib/stream/access-revocation",
    ) as { redriveAccessRevocation: jest.Mock };
    let now = 5_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    findMany.mockResolvedValue([]);
    const row = (id: string, kind: string) => ({
      id,
      kind,
      erasureRequestId: null,
      erasureRequest: null,
      userId: "payer-1",
      counterpartUserId: null,
      planType: null,
      planId: "refund-1",
      attempts: 0,
      nextRetryAt: null,
      createdAt: new Date(),
    });
    outboxFindMany.mockResolvedValueOnce([
      row("retry-a", "SEAT_ACCESS_REVOKE"),
      row("retry-b", "REFUND_ACCESS_REVOKE"),
    ]);
    // The first row leaves 4 s of the 16 s run budget: too little for another seat drive.
    redriveAccessRevocation.mockImplementationOnce(async () => {
      now += 12_000;
      return null;
    });

    try {
      await retryModerationEnforcement();
    } finally {
      clock.mockRestore();
    }

    expect(redriveAccessRevocation).toHaveBeenCalledTimes(1);
    expect(outboxUpdateMany).toHaveBeenCalledTimes(1);
    expect(outboxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "retry-a" }),
      }),
    );
  });

  it("leaves a row a writer re-armed during the attempt owed, without spending an attempt", async () => {
    findMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValueOnce([
      {
        id: "retry-seat",
        kind: "SEAT_ACCESS_REVOKE",
        erasureRequestId: null,
        erasureRequest: null,
        userId: "attendee-1",
        counterpartUserId: null,
        planType: null,
        planId: "appt-1",
        attempts: 2,
        nextRetryAt: new Date(1_000),
        createdAt: new Date(),
      },
    ]);
    // The re-arm replaced the generation, so the outcome write matches nothing.
    outboxUpdateMany.mockResolvedValueOnce({ count: 0 });
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const result = await retryModerationEnforcement();
    warn.mockRestore();

    expect(outboxFindMany.mock.calls[0][0].select).toMatchObject({
      nextRetryAt: true,
    });
    expect(outboxUpdateMany).toHaveBeenCalledWith({
      where: { id: "retry-seat", attempts: 2, nextRetryAt: new Date(1_000) },
      data: { status: "SUCCEEDED", attempts: 3, completedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({
      accessRevocationsRecovered: 0,
      stillFailing: 0,
      gaveUp: 0,
    });
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

  it("caps only the kinds whose give-up leaves no one with lost access", async () => {
    await retryModerationEnforcement();

    expect(outboxFindMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ["PENDING", "FAILED"] },
    });
    expect(outboxFindMany.mock.calls[0][0].where.attempts).toBeUndefined();
    // The vendor leg keeps its cap.
    expect(vendorOutboxFindMany.mock.calls[0][0].where).toMatchObject({
      attempts: { lt: 6 },
    });
  });

  it("keeps a Stream erasure row past the cap on a daily retry and reports the crossing once", async () => {
    findMany.mockResolvedValue([]);
    const row = {
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
    outboxFindMany.mockImplementation(async () => [{ ...row }]);
    outboxUpdate.mockImplementation(
      async ({ data }: { data: { attempts: number } }) => {
        row.attempts = data.attempts;
        return {};
      },
    );
    // Another leg is still owed, so the erasure request stays open.
    outboxCount.mockResolvedValue(1);
    driveCollaboratorRevocationMock.mockRejectedValue(new Error("stream down"));

    const before = Date.now();
    const first = await retryModerationEnforcement();

    const firstWrite = outboxUpdate.mock.calls[0][0] as {
      data: { status: string; attempts: number; nextRetryAt: Date };
    };
    expect(firstWrite.data).toMatchObject({ status: "FAILED", attempts: 6 });
    expect(firstWrite.data.nextRetryAt.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60_000,
    );
    expect(first.gaveUp).toBe(0);
    expect(first.stillFailing).toBe(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    // The next daily attempt still fails: retried again, not reported again.
    const second = await retryModerationEnforcement();

    expect(outboxUpdate).toHaveBeenCalledTimes(2);
    expect(outboxUpdate.mock.calls[1][0]).toMatchObject({
      data: { status: "FAILED", attempts: 7 },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(second.gaveUp).toBe(0);
    expect(erasureRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("still gives up on a capped kind at the cap", async () => {
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
        attempts: 5,
        nextRetryAt: new Date(1_000),
        createdAt: new Date(),
      },
    ]);
    redriveAccessRevocation.mockResolvedValueOnce("DM removal failed");

    const result = await retryModerationEnforcement();

    expect(outboxUpdateMany).toHaveBeenCalledWith({
      where: { id: "retry-dm", attempts: 5, nextRetryAt: new Date(1_000) },
      data: {
        status: "FAILED",
        attempts: 6,
        lastError: "DM removal failed",
        nextRetryAt: null,
      },
    });
    expect(result.gaveUp).toBe(1);
  });

  it("re-drives a seat row capped before this change once it is due", async () => {
    const { redriveAccessRevocation } = jest.requireMock(
      "../../lib/stream/access-revocation",
    ) as { redriveAccessRevocation: jest.Mock };
    findMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValueOnce([
      {
        id: "retry-old",
        kind: "SEAT_ACCESS_REVOKE",
        erasureRequestId: null,
        erasureRequest: null,
        userId: "attendee-1",
        counterpartUserId: null,
        planType: null,
        planId: "appt-1",
        attempts: 6,
        nextRetryAt: null,
        createdAt: new Date(),
      },
    ]);

    const result = await retryModerationEnforcement();

    expect(redriveAccessRevocation).toHaveBeenCalledTimes(1);
    expect(outboxUpdateMany).toHaveBeenCalledWith({
      where: { id: "retry-old", attempts: 6, nextRetryAt: null },
      data: { status: "SUCCEEDED", attempts: 7, completedAt: expect.any(Date) },
    });
    expect(result.accessRevocationsRecovered).toBe(1);
  });

  describe("without Stream's keys", () => {
    it("leaves every owed Stream row due, spends no attempt and reports through the daily finding", async () => {
      const { redriveAccessRevocation } = jest.requireMock(
        "../../lib/stream/access-revocation",
      ) as { redriveAccessRevocation: jest.Mock };
      mockStreamConfigured = false;
      findMany.mockResolvedValue([]);
      outboxCount.mockResolvedValue(3);
      vendorOutboxCount.mockResolvedValueOnce(1);
      const warn = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      const result = await retryModerationEnforcement();
      warn.mockRestore();

      expect(outboxFindMany).not.toHaveBeenCalled();
      expect(redriveAccessRevocation).not.toHaveBeenCalled();
      expect(outboxUpdateMany).not.toHaveBeenCalled();
      expect(outboxUpdate).not.toHaveBeenCalled();
      expect(vendorOutboxUpdate).not.toHaveBeenCalled();
      expect(result.streamUnconfigured).toBe(4);
      // Counted, not fetched, so a page of STREAM rows cannot starve the other vendors.
      expect(vendorOutboxCount).toHaveBeenCalledWith({
        where: expect.objectContaining({ vendor: "STREAM" }),
      });
      expect(vendorOutboxFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ vendor: { not: "STREAM" } }),
        }),
      );
      expect(result.success).toBe(false);
      expect(result.errors).toEqual([
        "Stream not configured: 4 owed Stream revocations or erasures left pending",
      ]);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      // Deduped across instances for a day, not per warm instance.
      expect(mockReportStandingFinding).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "retry-moderation-enforcement:stream-unconfigured",
          ids: ["stream-keys"],
        }),
        expect.any(Function),
      );
    });

    it("drains the same rows once the keys are back", async () => {
      const { redriveAccessRevocation } = jest.requireMock(
        "../../lib/stream/access-revocation",
      ) as { redriveAccessRevocation: jest.Mock };
      findMany.mockResolvedValue([]);
      const seat = {
        id: "retry-seat",
        kind: "SEAT_ACCESS_REVOKE",
        erasureRequestId: null,
        erasureRequest: null,
        userId: "attendee-1",
        counterpartUserId: null,
        planType: null,
        planId: "appt-1",
        attempts: 0,
        nextRetryAt: new Date(1_000),
        createdAt: new Date(),
      };
      outboxFindMany.mockResolvedValue([seat]);
      outboxCount.mockResolvedValue(1);
      mockStreamConfigured = false;
      const warn = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      await retryModerationEnforcement();
      warn.mockRestore();
      expect(redriveAccessRevocation).not.toHaveBeenCalled();

      mockStreamConfigured = true;
      const result = await retryModerationEnforcement();

      expect(redriveAccessRevocation).toHaveBeenCalledTimes(1);
      expect(outboxUpdateMany).toHaveBeenCalledWith({
        where: { id: "retry-seat", attempts: 0, nextRetryAt: new Date(1_000) },
        data: {
          status: "SUCCEEDED",
          attempts: 1,
          completedAt: expect.any(Date),
        },
      });
      expect(result.streamUnconfigured).toBe(0);
      expect(result.accessRevocationsRecovered).toBe(1);
    });
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
