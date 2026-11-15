/**
 * @jest-environment node
 */

/**
 * A trial-scheduled bell is keyed to its trial: a later trial for the same
 * pair, plan and time stages its own row, and a retry of one trial does not.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import { stageTrialScheduledNotices } from "@/lib/trials/schedule-notices";

const bell = {
  workflowId: "trial-session-scheduled" as const,
  kind: "SINGLE" as const,
  recipients: ["user-learner"],
  payload: { planTitle: "Plan", dateTime: "Sat, 6 Sep 2026" },
};

async function stagedTransactionIds(trialId: string): Promise<string[]> {
  const createManyAndReturn = jest.fn(
    async (_args: { data: { transactionId: string }[] }) => [],
  );
  const tx = {
    notificationOutbox: { createManyAndReturn },
    failedEmail: { createManyAndReturn: jest.fn(async () => []) },
  } as unknown as Tx;
  await stageTrialScheduledNotices(tx, trialId, {
    bells: [bell],
    emails: {
      prepared: {
        emailType: "TRIAL_SESSION_SCHEDULED",
        entityRef: "trial:pending",
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

it("keys the bell to the trial, so a replacement trial is not skipped as a duplicate", async () => {
  const first = await stagedTransactionIds("trial-1");
  expect(await stagedTransactionIds("trial-1")).toEqual(first);
  expect(await stagedTransactionIds("trial-2")).not.toEqual(first);
});
