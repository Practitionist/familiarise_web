/**
 * @jest-environment node
 */

/**
 * #1775 C-9 — a paid trial's earning is written undelivered (holdUntil null)
 * and completion stamps the hold; before this the trial had no earnings arm
 * at all and paged EARNINGS_UNACCRUABLE_NO_CONSULTANT after 24 h.
 */

import { readFileSync } from "fs";
import { stampTrialEarningsHold } from "@/lib/trials/earnings-hold";

it("a TRIAL payment resolves to a consultant and writes holdUntil null", () => {
  const src = readFileSync(
    `${process.cwd()}/lib/payments/payouts/earnings-service.ts`,
    "utf8",
  );
  expect(src).toContain('TRIAL: "SUBSCRIPTION"');
  expect(src).toContain("appointment.trial?.subscriptionPlan");
  expect(src).toMatch(
    /const holdUntil = payment\.appointment\?\.trial\s*\? null/,
  );
});

it("completion stamps only the rows still waiting", async () => {
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const completedAt = new Date("2026-09-25T10:00:00Z");
  await stampTrialEarningsHold(
    {
      consultantEarnings: { updateMany },
      organizationEarnings: { updateMany },
    } as never,
    "pay_trial",
    completedAt,
  );
  const [call] = updateMany.mock.calls as unknown as [
    { where: unknown; data: { holdUntil: Date } },
  ][];
  expect(call[0].where).toEqual({ paymentId: "pay_trial", holdUntil: null });
  expect(call[0].data.holdUntil.getTime()).toBeGreaterThan(
    completedAt.getTime(),
  );
});
