/**
 * @jest-environment node
 */

/**
 * A new request's bell is keyed to its request: a retry that stages the same
 * request again maps to the same outbox row, and another request does not.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import { stageNewRequestNotices } from "@/lib/booking/request-notices";
import { stagedBellTransactionIds } from "../fixtures/staged-bell-ids";

const stagedTransactionIds = (requestId: string) =>
  stagedBellTransactionIds(
    (tx, prepared) => stageNewRequestNotices(tx, requestId, prepared),
    {
      workflowId: "new-booking-request",
      kind: "SINGLE",
      recipients: ["user-expert"],
      payload: { planTitle: "Plan", requestedDateTime: "Sat, 6 Sep 2026" },
    },
    "NEW_BOOKING_REQUEST",
  );

it("keys the bell to the request: a repeat stages the same row, another request its own", async () => {
  const first = await stagedTransactionIds("req-1");
  expect(await stagedTransactionIds("req-1")).toEqual(first);
  expect(await stagedTransactionIds("req-2")).not.toEqual(first);
});
