import { faker } from "@faker-js/faker";
import { PaymentGateway, Prisma, RefundStatus } from "@prisma/client";
import prisma from "../../lib/prisma";

/**
 * #1757 — every seeded refund is SUCCEEDED. A PENDING row on a gateway that
 * never saw its id (FAMILIARISE_WEB-3V) or has no live client (STRIPE fenced,
 * CARD unimplemented) is a row no sweep can settle; FAILED rows would page the
 * payer through notifyFailedRefunds. Settled is the only seed-safe state.
 */
export function seedRefundStatus(_gateway: PaymentGateway): RefundStatus {
  return "SUCCEEDED";
}

// Refund reasons
const REFUND_REASONS = [
  "Customer request - changed mind",
  "Customer request - scheduling conflict",
  "Service not provided as described",
  "Duplicate payment processed",
  "Technical issues prevented session",
  "Consultant unavailable",
  "Quality issue with consultation",
  "Session cancelled by consultant",
  "Billing error correction",
  "Partial refund for shortened session",
];

/**
 * Generate gateway-specific refund ID
 */
function generateRefundId(gateway: PaymentGateway): string {
  switch (gateway) {
    case "STRIPE":
      return `re_${faker.string.alphanumeric(24)}`;
    case "RAZORPAY":
      return `rfnd_${faker.string.alphanumeric(14)}`;
    case "CARD":
      return `card_rf_${faker.string.alphanumeric(12)}`;
    default:
      return `ref_${faker.string.alphanumeric(16)}`;
  }
}

import { config } from "./config";

// Refund volume - configurable via SEED_MODE environment variable
const NUM_REFUNDS = config.volumes.refunds;

export async function createRefunds(): Promise<void> {
  console.log(`Creating ${NUM_REFUNDS} refunds...`);

  // Get succeeded payments that can have refunds
  const succeededPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      refunds: {
        none: {}, // Payments without existing refunds
      },
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentGateway: true,
    },
    take: NUM_REFUNDS * 2, // Get more than needed
  });

  if (succeededPayments.length === 0) {
    console.warn("No eligible payments found for refund creation");
    return;
  }

  let created = 0;

  for (let i = 0; i < Math.min(NUM_REFUNDS, succeededPayments.length); i++) {
    try {
      const payment = succeededPayments[i];
      const status = seedRefundStatus(payment.paymentGateway);

      // Refund amount: 70% full refund, 30% partial refund
      const isFullRefund = faker.datatype.boolean({ probability: 0.7 });
      const refundAmount = isFullRefund
        ? payment.amount
        : faker.number.int({
            min: Math.floor(payment.amount * 0.2),
            max: Math.floor(payment.amount * 0.8),
          });

      const reason = faker.helpers.arrayElement(REFUND_REASONS);
      const refundId = generateRefundId(payment.paymentGateway);

      // Metadata based on status
      const metadata: Record<string, Prisma.JsonValue> = {
        initiatedBy: "customer",
        requestDate: faker.date.recent({ days: 30 }).toISOString(),
      };

      metadata.processedAt = faker.date.recent({ days: 14 }).toISOString();
      metadata.transferId = faker.string.alphanumeric(16);

      await prisma.refund.create({
        data: {
          amountPaise: refundAmount,
          currency: payment.currency,
          reason,
          status,
          refundId,
          paymentGateway: payment.paymentGateway,
          metadata,
          paymentId: payment.id,
          createdAt: faker.date.recent({ days: 30 }),
        },
      });

      created++;
      if (created % 10 === 0) {
        console.log(`Created ${created} refunds...`);
      }
    } catch (error) {
      console.error(`Failed to create refund ${i + 1}:`, error);
    }
  }

  console.log(`Created ${created} refunds`);
}
