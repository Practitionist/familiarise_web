/**
 * @jest-environment node
 */

/**
 * #1708 — the chat pass of `reconcile-orphaned-confirmations` selects every
 * appointment with `chatChannelEnsuredAt IS NULL`, oldest first. A pair that
 * Stream's DM rule refuses (`DmNotPermittedError`) can never succeed on a
 * retry, so leaving the row unmarked put it at the head of the queue on every
 * tick and the pass never converged. The sweep now stamps that row out of the
 * queue and reports it as `channelsSkipped`; a generic throw is still a
 * `channelsFailed` retry and writes nothing.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
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

import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { ensureChannelsForAppointment } from "../../lib/payments/webhooks/ensure-channels";
import { DmNotPermittedError } from "../../lib/stream/dm-eligibility";
import { reconcileOrphanedConfirmations } from "../../scripts/payments/reconcile-orphaned-confirmations";

const mockEnsure = ensureChannelsForAppointment as jest.Mock;
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;
const updateMany = prisma.appointment.updateMany as jest.Mock;

describe("reconcile-orphaned-confirmations — DM not permitted (#1708)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([
      { id: "appt-1", _count: { payment: 1 } },
    ]);
  });

  it("stamps the row out of the queue and counts it as skipped", async () => {
    mockEnsure.mockRejectedValue(new DmNotPermittedError("u-a", "u-b"));

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(result.channelsSkipped).toBe(1);
    expect(result.channelsFailed).toBe(0);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "appt-1", chatChannelEnsuredAt: null },
      data: { chatChannelEnsuredAt: expect.any(Date) },
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("1 appointment(s)"),
      expect.objectContaining({
        level: "warning",
        fingerprint: ["reconcile-orphaned-confirmations", "dm_not_permitted"],
        extra: { appointmentIds: ["appt-1"] },
      }),
    );
  });

  it("leaves a generic throw in the queue as a failed retry", async () => {
    mockEnsure.mockRejectedValue(new Error("Stream 503"));

    const result = await reconcileOrphanedConfirmations({ limit: 10 });

    expect(result.channelsFailed).toBe(1);
    expect(result.channelsSkipped).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
