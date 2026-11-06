/**
 * @jest-environment node
 */

/**
 * Novu webhooks carry the per-recipient transactionId a targeted row was sent
 * under. Pins: the handler maps it back to the row, and one recipient's
 * delivery settles only a single-recipient row.
 */

const mockUpdateMany = jest.fn();
const mockRecordSystemEvent = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...args: unknown[]) => mockRecordSystemEvent(...args),
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => false,
  getNovuClient: jest.fn(),
}));

import { recipientTransactionId } from "@/lib/novu/outbox";
import { processNovuWebhookPayload } from "@/lib/webhooks/novu-handler";

const rowTransactionId = `payment-failed:${"b".repeat(32)}`;

afterEach(() => jest.clearAllMocks());

it("settles only a single-recipient row when one recipient's bell is delivered", async () => {
  await processNovuWebhookPayload({
    type: "message.sent",
    transactionId: recipientTransactionId(rowTransactionId, "u1"),
  });

  expect(mockUpdateMany).toHaveBeenCalledWith({
    where: {
      transactionId: rowTransactionId,
      status: "PENDING",
      kind: "SINGLE",
    },
    data: expect.objectContaining({ status: "SENT" }),
  });
});

it("records a delivery failure on the row the recipient's event belongs to", async () => {
  await processNovuWebhookPayload({
    type: "message.failed",
    transactionId: recipientTransactionId(rowTransactionId, "u2"),
    error: "subscriber not found",
  });

  expect(mockUpdateMany).toHaveBeenCalledWith({
    where: { transactionId: rowTransactionId },
    data: { lastError: "subscriber not found" },
  });
});
