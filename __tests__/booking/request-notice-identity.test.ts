/**
 * @jest-environment node
 */

/**
 * A new request's bell is keyed to its request: a retry that stages the same
 * request again maps to the same outbox row, and another request does not.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import { stageNewRequestNotices } from "@/lib/booking/request-notices";

const bell = {
  workflowId: "new-booking-request" as const,
  kind: "SINGLE" as const,
  recipients: ["user-expert"],
  payload: { planTitle: "Plan", requestedDateTime: "Sat, 6 Sep 2026" },
};

async function stagedTransactionIds(requestId: string): Promise<string[]> {
  const createManyAndReturn = jest.fn(
    async (_args: { data: { transactionId: string }[] }) => [],
  );
  const tx = {
    notificationOutbox: { createManyAndReturn },
    failedEmail: { createManyAndReturn: jest.fn(async () => []) },
  } as unknown as Tx;
  await stageNewRequestNotices(tx, requestId, {
    bells: [bell],
    emails: {
      prepared: {
        emailType: "NEW_BOOKING_REQUEST",
        entityRef: "request:pending",
        messages: [],
        skipped: 0,
        failed: 0,
      },
      screened: [],
    },
  });
  return createManyAndReturn.mock.calls[0][0].data.map(
    (row) => row.transactionId,
  );
}

it("keys the bell to the request: a repeat stages the same row, another request its own", async () => {
  const first = await stagedTransactionIds("req-1");
  expect(await stagedTransactionIds("req-1")).toEqual(first);
  expect(await stagedTransactionIds("req-2")).not.toEqual(first);
});
