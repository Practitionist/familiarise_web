/**
 * @jest-environment node
 */

/**
 * #1708 — the chat pass of `reconcile-orphaned-confirmations` selects every
 * appointment with `chatChannelEnsuredAt IS NULL`, oldest first. A pair that
 * Stream's DM rule refuses (`DmNotPermittedError`) can never succeed on a
 * retry, so leaving the row unmarked put it at the head of the queue on every
 * tick and the pass never converged. The sweep now stamps that row out of the
 * queue and records it as `channelsSkipped` in a `SystemEvent`; a generic throw is still a
 * `channelsFailed` retry and writes nothing. The stamp and the event share one
 * transaction, so a failed event insert rolls the stamp back.
 */

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// A fake transaction: stamps staged through `tx` commit only when the callback resolves.
const mockCommittedStamps: unknown[] = [];
const mockTxUpdateMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: unknown[] = [];
      mockTxUpdateMany.mockImplementation(async (args: unknown) => {
        staged.push(args);
        return { count: 1 };
      });
      const result = await fn({
        appointment: { updateMany: mockTxUpdateMany },
      });
      mockCommittedStamps.push(...staged);
      return result;
    }),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => Promise<unknown>) => fn(),
}));
jest.mock("../../lib/payments/webhooks/ensure-channels", () => ({
  ensureChannelsForAppointment: jest.fn(),
}));
// The confirmation pass is not exercised here; its handler drags in the
// whole capture pipeline.
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  confirmExistingAppointment: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { recordSystemEvent } from "../../lib/enterprise/system-events";
import { reportSentryError } from "../../lib/observability/report";
import { ensureChannelsForAppointment } from "../../lib/payments/webhooks/ensure-channels";
import { DmNotPermittedError } from "../../lib/stream/dm-eligibility";
import { reconcileOrphanedConfirmations } from "../../scripts/payments/reconcile-orphaned-confirmations";

const mockEnsure = ensureChannelsForAppointment as jest.Mock;
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;
const mockRecordEvent = recordSystemEvent as jest.Mock;
const globalUpdateMany = prisma.appointment.updateMany as jest.Mock;
const mockReportError = reportSentryError as jest.Mock;

describe("reconcile-orphaned-confirmations — DM not permitted (#1708)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCommittedStamps.length = 0;
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([
      { id: "appt-1", appointmentType: "WEBINAR", _count: { payment: 1 } },
    ]);
  });

  it("stamps the row out of the queue and counts it as skipped", async () => {
    mockEnsure.mockRejectedValue(new DmNotPermittedError("u-a", "u-b"));

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(result.channelsSkipped).toBe(1);
    expect(result.channelsFailed).toBe(0);
    expect(globalUpdateMany).not.toHaveBeenCalled();
    expect(mockCommittedStamps).toEqual([
      {
        where: { id: { in: ["appt-1"] }, chatChannelEnsuredAt: null },
        data: { chatChannelEnsuredAt: expect.any(Date) },
      },
    ]);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        db: expect.objectContaining({ appointment: expect.anything() }),
        strict: true,
        severity: "WARN",
        message: expect.stringContaining("1 appointment(s)"),
        context: {
          skipped: [
            {
              appointmentId: "appt-1",
              appointmentType: "WEBINAR",
              reason: "dm_not_permitted",
            },
          ],
        },
      }),
    );
  });

  it("reports the no-channel-branch reason and appointment type", async () => {
    mockEnsure.mockResolvedValue({
      ensured: false,
      reason: "no_channel_branch_for_appointment",
    });

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(result.channelsSkipped).toBe(1);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          skipped: [
            expect.objectContaining({
              reason: "no_channel_branch_for_appointment",
              appointmentType: "WEBINAR",
            }),
          ],
        },
      }),
    );
  });

  it("leaves a generic throw in the queue as a failed retry", async () => {
    mockEnsure.mockRejectedValue(new Error("Stream 503"));

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(result.channelsFailed).toBe(1);
    expect(result.channelsSkipped).toBe(0);
    expect(globalUpdateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("rolls the stamp back and keeps the row queued when the event insert fails", async () => {
    mockEnsure.mockRejectedValue(new DmNotPermittedError("u-a", "u-b"));
    mockRecordEvent.mockRejectedValueOnce(
      new Error("system_events insert failed"),
    );

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(mockTxUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockCommittedStamps).toEqual([]);
    expect(globalUpdateMany).not.toHaveBeenCalled();
    expect(result.channelsSkipped).toBe(0);
    expect(result.channelsFailed).toBe(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});
