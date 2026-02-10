import { faker } from "@faker-js/faker";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  calculatePlatformFee,
  calculateConsultantShare,
  generateHoldUntilDate,
  weightedRandom,
  EARNING_STATUS_WEIGHTS,
} from "./utils";

// Type for payment with appointment data
type PaymentWithAppointment = Prisma.PaymentGetPayload<{
  include: {
    appointment: {
      include: {
        consultation: {
          include: {
            consultationPlan: true;
          };
        };
        subscription: {
          include: {
            subscriptionPlan: true;
          };
        };
        webinar: {
          include: {
            webinarPlan: true;
          };
        };
        class: {
          include: {
            classPlan: true;
          };
        };
      };
    };
  };
}>;

/**
 * Extract consultant profile ID from payment's appointment
 */
function getConsultantProfileIdFromPayment(
  payment: PaymentWithAppointment,
): string | null {
  const appointment = payment.appointment;
  if (!appointment) return null;

  // Check each appointment type and get the consultant from the plan
  if (appointment.consultation?.consultationPlan) {
    return appointment.consultation.consultationPlan.consultantProfileId;
  }
  if (appointment.subscription?.subscriptionPlan) {
    return appointment.subscription.subscriptionPlan.consultantProfileId;
  }
  if (appointment.webinar?.webinarPlan) {
    return appointment.webinar.webinarPlan.consultantProfileId;
  }
  if (appointment.class?.classPlan) {
    return appointment.class.classPlan.consultantProfileId;
  }

  return null;
}

/**
 * Generate paidAt date based on holdUntil for PAID status
 */
function generatePaidAtDate(holdUntil: Date): Date {
  // Payment happens 1-5 days after hold period ends
  const daysAfterHold = faker.number.int({ min: 1, max: 5 });
  const paidAt = new Date(holdUntil);
  paidAt.setDate(paidAt.getDate() + daysAfterHold);
  return paidAt;
}

export async function createConsultantEarnings(): Promise<void> {
  console.log("Creating consultant earnings...");

  // Get SUCCEEDED payments without existing earnings records
  const succeededPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      earnings: { none: {} }, // No existing earnings record
      appointment: {
        isNot: null, // Must have an appointment
      },
    },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: true,
            },
          },
          subscription: {
            include: {
              subscriptionPlan: true,
            },
          },
          webinar: {
            include: {
              webinarPlan: true,
            },
          },
          class: {
            include: {
              classPlan: true,
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${succeededPayments.length} SUCCEEDED payments to process`,
  );

  if (succeededPayments.length === 0) {
    console.warn("No eligible payments found for earnings creation");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const payment of succeededPayments) {
    try {
      // Get consultant profile ID from the payment's appointment
      const consultantProfileId = getConsultantProfileIdFromPayment(payment);

      if (!consultantProfileId) {
        console.warn(
          `Could not find consultant for payment ${payment.id}, skipping`,
        );
        skipped++;
        continue;
      }

      // Calculate revenue breakdown
      const grossAmount = payment.amount;
      const platformFee = calculatePlatformFee(grossAmount);
      const consultantShare = calculateConsultantShare(grossAmount);

      // Assign status based on weighted distribution
      const status = weightedRandom(EARNING_STATUS_WEIGHTS);

      // Calculate hold period (based on payment creation date)
      const holdUntil = generateHoldUntilDate(payment.createdAt);

      // Set paidAt only for PAID status
      const paidAt = status === "PAID" ? generatePaidAtDate(holdUntil) : null;

      await prisma.consultantEarnings.create({
        data: {
          consultantProfileId,
          paymentId: payment.id,
          grossAmount,
          platformFee,
          consultantShare,
          status,
          holdUntil,
          paidAt,
        },
      });

      created++;
      if (created % 20 === 0) {
        console.log(`Created ${created} earnings records...`);
      }
    } catch (error) {
      console.error(
        `Failed to create earnings for payment ${payment.id}:`,
        error,
      );
      skipped++;
    }
  }

  // Log summary
  console.log(`\nConsultant Earnings Summary:`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);

  const statusSummary = await prisma.consultantEarnings.groupBy({
    by: ["status"],
    _count: true,
    _sum: {
      consultantShare: true,
    },
  });

  console.log("\nEarnings by Status:");
  for (const item of statusSummary) {
    const totalAmount = item._sum.consultantShare || 0;
    console.log(
      `  ${item.status}: ${item._count} records (Total Share: ${(totalAmount / 100).toFixed(2)} INR)`,
    );
  }
}
