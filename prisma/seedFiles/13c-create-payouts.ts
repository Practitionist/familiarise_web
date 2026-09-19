import { faker } from "@faker-js/faker";
import {
  Currency,
  EarningStatus,
  PaymentGateway,
  PayoutMethod,
  PayoutStatus,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  generateBatchId,
  generateIdempotencyKey,
  weightedRandom,
  PAYOUT_PROVIDER_WEIGHTS,
} from "./utils";
import { sumPaise } from "../../lib/payments/utils/money";
import { postLedgerTxn, type Posting } from "../../lib/payments/ledger/post";

/**
 * #1757 — statuses a seeded payout may take: only the ones the reconcilers
 * accept without a gateway. PROCESSING with a fake po_/pout_ id failed
 * reconcile-payout-status and handle-stuck-payouts on every run; FAILED rows
 * were noise. No seeded payout carries a providerPayoutId.
 */
export const SEED_PAYOUT_STATUS_WEIGHTS = [
  { value: PayoutStatus.COMPLETED, weight: 0.6 },
  { value: PayoutStatus.APPROVED, weight: 0.2 },
  { value: PayoutStatus.PENDING, weight: 0.2 },
];

/**
 * #1757 — the journal a COMPLETED consultant payout must carry (`payout:<id>`,
 * the shape handlePayoutWebhook posts): Dr CONSULTANT_PAYABLE / Cr CASH. Seeded
 * payouts withhold no TDS, so cash equals the gross payable.
 */
export function buildSeedPayoutPostings(input: {
  consultantProfileId: string;
  amountPaise: number;
}): Posting[] {
  return [
    {
      account: {
        kind: "CONSULTANT_PAYABLE",
        consultantProfileId: input.consultantProfileId,
      },
      direction: "DEBIT",
      amountPaise: input.amountPaise,
    },
    {
      account: { kind: "CASH" },
      direction: "CREDIT",
      amountPaise: input.amountPaise,
    },
  ];
}

/** #1757 — earnings behind a payout are BATCHED until it completes, PAID after. */
export function seedEarningStatusForPayout(
  status: PayoutStatus,
): EarningStatus {
  return status === PayoutStatus.COMPLETED
    ? EarningStatus.PAID
    : EarningStatus.BATCHED;
}

/**
 * Determine payout method based on provider
 */
function getPayoutMethod(provider: PaymentGateway): PayoutMethod {
  if (provider === PaymentGateway.STRIPE) {
    return PayoutMethod.STRIPE_TRANSFER;
  }
  // For Razorpay, randomly choose between bank transfer and UPI
  return faker.datatype.boolean({ probability: 0.7 })
    ? PayoutMethod.BANK_TRANSFER
    : PayoutMethod.UPI;
}

/**
 * Get currency based on provider
 */
function getCurrency(_provider: PaymentGateway): Currency {
  // Always INR. Payouts settle in INR whichever provider carries them —
  // processRazorpayPayout throws on anything else — so seeding USD payouts
  // for Stripe produced rows the real pipeline would reject, and inflated the
  // dashboards that sum payout amounts without grouping by currency.
  return Currency.INR;
}

/**
 * Group earnings by consultant
 */
function groupEarningsByConsultant(
  earnings: Array<{
    id: string;
    consultantProfileId: string;
    consultantSharePaise: number;
  }>,
): Map<string, typeof earnings> {
  const grouped = new Map<string, typeof earnings>();

  for (const earning of earnings) {
    const existing = grouped.get(earning.consultantProfileId) || [];
    existing.push(earning);
    grouped.set(earning.consultantProfileId, existing);
  }

  return grouped;
}

export async function createPayouts(): Promise<void> {
  console.log("Creating payouts...");

  // Get PAID earnings that are not yet linked to a payout
  const paidEarnings = await prisma.consultantEarnings.findMany({
    where: {
      status: "PAID",
      payoutId: null,
    },
    select: {
      id: true,
      consultantProfileId: true,
      consultantSharePaise: true,
    },
  });

  console.log(`Found ${paidEarnings.length} PAID earnings to process`);

  if (paidEarnings.length === 0) {
    console.log("No PAID earnings found without payouts");
    return;
  }

  // Group earnings by consultant
  const earningsByConsultant = groupEarningsByConsultant(paidEarnings);
  console.log(`Grouped into ${earningsByConsultant.size} consultant payouts`);

  // Get admin users for approvedBy field
  const adminUsers = await prisma.user.findMany({
    where: {
      role: "ADMIN",
    },
    select: {
      id: true,
    },
    take: 5,
  });

  let payoutsCreated = 0;
  let earningsLinked = 0;

  // Create a payout for each consultant with PAID earnings
  const consultantEntries = Array.from(earningsByConsultant.entries());
  for (const [consultantProfileId, earnings] of consultantEntries) {
    try {
      // Calculate total amount for this payout
      const totalAmount = earnings.reduce(
        (sum, e) => sum + e.consultantSharePaise,
        0,
      );

      // Determine provider and related fields
      const provider = weightedRandom(PAYOUT_PROVIDER_WEIGHTS);
      const method = getPayoutMethod(provider);
      const currency = getCurrency(provider);
      const status = weightedRandom(SEED_PAYOUT_STATUS_WEIGHTS);

      // Generate dates based on status
      const createdAt = faker.date.recent({ days: 30 });
      let processedAt: Date | null = null;
      let approvedAt: Date | null = null;
      let approvedBy: string | null = null;

      // Set fields based on status
      switch (status) {
        case "COMPLETED":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60); // 1 hour after creation
          processedAt = new Date(approvedAt.getTime() + 1000 * 60 * 60 * 2); // 2 hours after approval
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          break;
        case "APPROVED":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60);
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          break;
        // PENDING needs no additional fields
      }

      const earningIds = earnings.map((e) => e.id);
      const earningStatus = seedEarningStatusForPayout(status);

      // One tx: the payout, its earnings link and (when COMPLETED) its
      // `payout:<id>` journal, so a fresh seed reconciles with zero
      // COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN findings (#1757).
      await prisma.$transaction(async (tx) => {
        const row = await tx.consultantPayout.create({
          data: {
            consultantProfileId,
            provider,
            providerPayoutId: null,
            amount: totalAmount,
            currency,
            status,
            method,
            batchId: generateBatchId(createdAt),
            failureReason: null,
            retryCount: 0,
            processedAt,
            approvedAt,
            approvedBy,
            idempotencyKey: generateIdempotencyKey(),
            createdAt,
          },
        });
        await tx.consultantEarnings.updateMany({
          where: { id: { in: earningIds } },
          data: {
            payoutId: row.id,
            status: earningStatus,
            paidAt: earningStatus === EarningStatus.PAID ? processedAt : null,
          },
        });
        if (status === PayoutStatus.COMPLETED && totalAmount > 0) {
          await postLedgerTxn(tx, {
            idempotencyKey: `payout:${row.id}`,
            kind: "PAYOUT",
            payoutId: row.id,
            postings: buildSeedPayoutPostings({
              consultantProfileId,
              amountPaise: totalAmount,
            }),
          });
        }
      });

      payoutsCreated++;

      earningsLinked += earningIds.length;

      if (payoutsCreated % 10 === 0) {
        console.log(`Created ${payoutsCreated} payouts...`);
      }
    } catch (error) {
      console.error(
        `Failed to create payout for consultant ${consultantProfileId}:`,
        error,
      );
    }
  }

  // Log summary
  console.log(`\nPayouts Summary:`);
  console.log(`  Total payouts created: ${payoutsCreated}`);
  console.log(`  Total earnings linked: ${earningsLinked}`);

  const statusSummary = await prisma.consultantPayout.groupBy({
    by: ["status"],
    _count: true,
    _sum: {
      amount: true,
    },
  });

  console.log("\nPayouts by Status:");
  for (const item of statusSummary) {
    const totalAmount = sumPaise(item._sum.amount);
    console.log(
      `  ${item.status}: ${item._count} payouts (Total: ${(totalAmount / 100).toFixed(2)} INR)`,
    );
  }

  const providerSummary = await prisma.consultantPayout.groupBy({
    by: ["provider"],
    _count: true,
  });

  console.log("\nPayouts by Provider:");
  for (const item of providerSummary) {
    console.log(`  ${item.provider}: ${item._count}`);
  }
}
