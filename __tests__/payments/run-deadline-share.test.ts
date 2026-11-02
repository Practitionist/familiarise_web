/**
 * @jest-environment node
 */

/** A loop given a share of the run's start budget stops early, leaving the rest. */
import {
  startDeadline,
  startDeadlineShare,
  SWEEP_START_DEADLINE_MS,
} from "@/lib/cron/run-deadline";

it("stops a half-share loop at half the budget while the run goes on", () => {
  const startedAt = 1_000_000;
  const now = jest.spyOn(Date, "now");
  const half = startDeadlineShare(0.5, startedAt);
  const whole = startDeadline(startedAt);

  now.mockReturnValue(startedAt + SWEEP_START_DEADLINE_MS / 2 - 1);
  expect([half(), whole()]).toEqual([false, false]);
  now.mockReturnValue(startedAt + SWEEP_START_DEADLINE_MS / 2);
  expect([half(), whole()]).toEqual([true, false]);
  now.mockReturnValue(startedAt + SWEEP_START_DEADLINE_MS);
  expect([half(), whole()]).toEqual([true, true]);
  now.mockRestore();
});
