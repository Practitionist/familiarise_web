/**
 * @jest-environment node
 */

/**
 * A trial-scheduled bell is keyed to its trial: a later trial for the same
 * pair, plan and time stages its own row, and a retry of one trial does not.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import { stageTrialScheduledNotices } from "@/lib/trials/schedule-notices";
import { stagedBellTransactionIds } from "../fixtures/staged-bell-ids";

const stagedTransactionIds = (trialId: string) =>
  stagedBellTransactionIds(
    (tx, prepared) => stageTrialScheduledNotices(tx, trialId, prepared),
    {
      workflowId: "trial-session-scheduled",
      kind: "SINGLE",
      recipients: ["user-learner"],
      payload: { planTitle: "Plan", dateTime: "Sat, 6 Sep 2026" },
    },
    "TRIAL_SESSION_SCHEDULED",
  );

it("keys the bell to the trial, so a replacement trial is not skipped as a duplicate", async () => {
  const first = await stagedTransactionIds("trial-1");
  expect(await stagedTransactionIds("trial-1")).toEqual(first);
  expect(await stagedTransactionIds("trial-2")).not.toEqual(first);
});
