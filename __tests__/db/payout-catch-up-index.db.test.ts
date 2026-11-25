/**
 * The 194-O catch-up index against real Postgres: claiming a re-armed payout that
 * kept its staged catch-up, while another payout of the expert holds that FY's
 * catch-up, raises the unique violation the payout service recognises, and the
 * payout can then be failed unsent with its staged TDS cleared.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import { isUniqueViolationOn } from "../../lib/db/unique-violation";
import { getIndianFinancialYear } from "../../lib/payments/tax/tds-service";
import { seedHost } from "./booking/harness";

it("refuses the claim of a payout whose staged catch-up another live payout holds, and lets it fail unsent", async () => {
  const { consultantProfileId } = await seedHost();
  const fy = getIndianFinancialYear();
  const base = {
    consultantProfileId,
    provider: "RAZORPAY" as const,
    method: "BANK_TRANSFER" as const,
    amount: 1_600_000,
    tdsFinancialYear: fy,
    tdsCatchUpFy: fy,
    tdsRateAppliedBps: 10,
  };
  await prisma.consultantPayout.create({
    data: {
      ...base,
      status: "COMPLETED",
      tdsDeducted: 51_000,
      netAmount: 1_549_000,
      idempotencyKey: `instant_${randomUUID()}`,
    },
  });
  const retry = await prisma.consultantPayout.create({
    data: {
      ...base,
      status: "APPROVED",
      retryCount: 1,
      tdsDeducted: 51_000,
      netAmount: 1_549_000,
      idempotencyKey: `payout_${randomUUID()}`,
    },
  });

  // The claim the payout service issues on a staged row.
  const claim = prisma.consultantPayout.updateMany({
    where: { id: retry.id, status: "APPROVED", netAmount: 1_549_000 },
    data: { status: "PROCESSING" },
  });
  const err = await claim.then(
    () => null,
    (e: unknown) => e,
  );
  expect(
    isUniqueViolationOn(err, "consultant_payout_one_tds_catch_up_per_fy") ||
      isUniqueViolationOn(err, "tdsCatchUpFy"),
  ).toBe(true);

  const failed = await prisma.consultantPayout.updateMany({
    where: { id: retry.id, status: "APPROVED", providerPayoutId: null },
    data: {
      status: "FAILED",
      tdsDeducted: 0,
      netAmount: null,
      tdsRateAppliedBps: null,
      tdsFinancialYear: null,
      tdsCatchUpFy: null,
      tdsCarryPaise: 0,
      tdsCreditPaise: 0,
    },
  });
  expect(failed.count).toBe(1);
});
