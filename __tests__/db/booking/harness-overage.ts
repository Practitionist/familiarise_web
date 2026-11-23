/** Member-overage seeds for the database tier: a licensed seat past its cap and an unpaid side payment. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS } from "./harness";

const DAY_MS = 24 * HOUR_MS;

/** An ACTIVE licence-funded organisation whose member's seat covers `cap` sessions and charges the member past it. */
export async function seedLicensedMember(userId: string, cap: number) {
  const org = await prisma.organization.create({
    data: {
      name: "Licensed org",
      slug: `licensed-${randomUUID()}`,
      status: "ACTIVE",
    },
  });
  const account = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      billingEmail: `${randomUUID()}@db-tier.example.invalid`,
      fundingSource: "LICENSE",
    },
  });
  await prisma.organization.update({
    where: { id: org.id },
    data: { billingAccountId: account.id },
  });
  const contract = await prisma.contract.create({
    data: {
      organizationId: org.id,
      billingAccountId: account.id,
      status: "ACTIVE",
      effectiveFrom: new Date(Date.now() - DAY_MS),
    },
  });
  const program = await prisma.program.create({
    data: {
      contractId: contract.id,
      type: "LICENSED_SEAT",
      name: "Seat",
      coveredPlanTypes: ["CONSULTATION"],
      licensedSeatConfig: {
        create: {
          ratePerSeatPaise: BigInt(0),
          cycle: "MONTHLY",
          coveredEngagementsPerCycle: cap,
          overageBehavior: "CHARGE_MEMBER",
        },
      },
    },
  });
  const membership = await prisma.membership.create({
    data: { userId, organizationId: org.id, role: "LEARNER" },
  });
  const assignment = await prisma.programAssignment.create({
    data: {
      programId: program.id,
      membershipId: membership.id,
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + 30 * DAY_MS),
    },
  });
  return { orgId: org.id, assignmentId: assignment.id };
}

/** A card-paid parent's unpaid ₹236 member overage (₹200 surcharge and its GST), as allocation records one. */
export async function seedUnpaidMemberOverage(
  parent: { id: string; amount: number },
  userId: string,
) {
  const { assignmentId } = await seedLicensedMember(userId, 0);
  const utilization = await prisma.bookingUtilization.create({
    data: {
      programAssignmentId: assignmentId,
      paymentId: parent.id,
      priceAtBookingPaise: parent.amount,
      wasOverage: true,
    },
  });
  const side = await prisma.payment.create({
    data: {
      amount: BigInt(23_600),
      originalAmount: BigInt(20_000),
      taxAmount: BigInt(3_600),
      paymentMethod: "CARD",
      paymentIntent: `overage:${parent.id}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "PENDING",
      userId,
      parentPaymentId: parent.id,
      legs: { create: { source: "CARD", amountPaise: BigInt(23_600) } },
    },
  });
  await prisma.overageEvent.create({
    data: {
      programAssignmentId: assignmentId,
      bookingUtilizationId: utilization.id,
      overageBehavior: "CHARGE_MEMBER",
      surchargePaise: BigInt(20_000),
      marginalPaise: BigInt(23_600),
      chargeStatus: "PENDING",
      paymentId: side.id,
    },
  });
  return side;
}

/** The payment's expert earnings with their active holds. */
export const earningsOf = (paymentId: string) =>
  prisma.consultantEarnings.findMany({
    where: { paymentId },
    orderBy: { cycleOrdinal: "asc" },
    include: {
      holds: {
        where: { releasedAt: null },
        select: { reason: true, sourceRef: true },
      },
    },
  });

export const overageHeld = (parentId: string) => ({
  status: "HELD",
  preHoldStatus: "PENDING",
  holds: [{ reason: "OVERAGE", sourceRef: parentId }],
});
export const released = { status: "PENDING", preHoldStatus: null, holds: [] };
