/**
 * @jest-environment node
 */

/**
 * The audited door that puts a terminal webhook event (gave up, or permanent)
 * back in the sweeper's queue: a compare-and-set on the terminal error it
 * read, refused for a row that is not terminal.
 */

type Tx = { webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock } };
type Door = {
  mode: string;
  run: (
    tx: Tx,
    ctx: { params: { webhookEventId: string }; body: { reason: string } },
  ) => Promise<{
    target: { kind: string; id: string };
    before: unknown;
    after: unknown;
    response: unknown;
  }>;
};
const mockDoors: { surface: string; action: string; door: Door }[] = [];
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  withOpsAction: (
    surface: string,
    action: string,
    _shape: object,
    door: Door,
  ) => {
    mockDoors.push({ surface, action, door });
    return jest.fn();
  },
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

const tx: Tx = {
  webhookEvent: { findUnique: jest.fn(), updateMany: jest.fn() },
};
const requeue = () =>
  mockDoors[0].door.run(tx, {
    params: { webhookEventId: "we-1" },
    body: { reason: "Decoder for the new refund speed is deployed" },
  });
const row = (error: string | null, processed = false) => ({
  id: "we-1",
  eventId: "refund.processed:rfnd_1:evt_1",
  eventType: "refund.processed",
  provider: "razorpay",
  processed,
  error,
});

beforeAll(async () => {
  await import("@/app/api/admin/webhook-events/[webhookEventId]/requeue/route");
});
beforeEach(() => {
  jest.clearAllMocks();
  tx.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
});

it("is a transactional door on the system-jobs surface", () => {
  expect(mockDoors).toHaveLength(1);
  expect(mockDoors[0]).toMatchObject({
    surface: "systemJobs.manage",
    action: "webhookEvent.requeue",
    door: { mode: "tx" },
  });
});

it.each([
  [
    "permanent: schema mismatch: refund.processed — speed_processed: Invalid enum value",
  ],
  ["gave up: still failing after 168h: Payment record not found"],
])(
  "requeues a terminal row by compare-and-set on the error it read (%s)",
  async (error) => {
    tx.webhookEvent.findUnique.mockResolvedValue(row(error));

    const result = await requeue();

    expect(tx.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "we-1", processed: false, error },
      data: { error: null, claimedAt: null, processedAt: null },
    });
    expect(result).toMatchObject({
      target: { kind: "WebhookEvent", id: "we-1" },
      before: { error },
      after: { error: null, queued: true },
      response: { status: "requeued", webhookEventId: "we-1" },
    });
  },
);

it.each([
  ["an event still being retried", row("sweep-failed: timeout")],
  ["an event with no error", row(null)],
  ["an event already processed", row(null, true)],
])("refuses %s and writes nothing", async (_label, current) => {
  tx.webhookEvent.findUnique.mockResolvedValue(current);

  const refusal = await requeue().catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(OpsRefusal);
  expect(refusal).toMatchObject({ code: "NOT_TERMINAL", httpStatus: 409 });
  expect(tx.webhookEvent.updateMany).not.toHaveBeenCalled();
});

it("answers 404 for an unknown event", async () => {
  tx.webhookEvent.findUnique.mockResolvedValue(null);

  await expect(requeue()).rejects.toMatchObject({
    code: "NOT_FOUND",
    httpStatus: 404,
  });
});

it("refuses when another actor moved the row first", async () => {
  tx.webhookEvent.findUnique.mockResolvedValue(
    row("permanent: schema mismatch"),
  );
  tx.webhookEvent.updateMany.mockResolvedValue({ count: 0 });

  await expect(requeue()).rejects.toMatchObject({
    code: "NOT_TERMINAL",
    httpStatus: 409,
  });
});
