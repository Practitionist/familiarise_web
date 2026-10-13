import {
  AppointmentsType,
  AppointmentFeedbackRole,
  AppointmentStatus,
  BookingSource,
  Currency,
  EarningRole,
  EarningStatus,
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
  OverageBehavior,
  OverageChargeStatus,
  ParticipantRole,
  ParticipantStatus,
  PaymentGateway,
  PaymentLegSource,
  PaymentStatus,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { postLedgerTxn } from "../../lib/payments/ledger/post";

interface SeedCompletedOrgConsultationArgs {
  planId: string;
  consulteeProfileId: string;
  learnerUserId: string;
  learnerOrgId: string;
  expertUserId: string;
  consultantProfileId: string;
  hostOrgId: string;
  appointmentOrgId: string;
  billingAccountId: string | null;
  startsAt: Date;
  endsAt: Date;
  requestedAt: Date;
  totalPricePaise: number;
  paymentMethod: string;
  seedTag: string;
  legs: Array<{
    source: PaymentLegSource;
    amountPaise: number;
    sourceRef: string;
  }>;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
  rating: number;
  comment: string;
}

async function seedCompletedOrgConsultation(
  args: SeedCompletedOrgConsultationArgs,
) {
  const dayMs = 24 * 60 * 60 * 1000;

  const consultation = await prisma.consultation.create({
    data: {
      consultationPlanId: args.planId,
      status: AppointmentStatus.COMPLETED,
      requestedById: args.consulteeProfileId,
      requestedAt: args.requestedAt,
      bookingSource: BookingSource.DIRECT_CHECKOUT,
    },
  });

  const appointment = await prisma.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      organizationId: args.appointmentOrgId,
      chatChannelEnsuredAt: args.startsAt,
    },
  });

  const occurrence = await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      consultantProfileId: args.consultantProfileId,
      ordinal: 1,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      isTentative: false,
      completionStatus: OccurrenceCompletionStatus.COMPLETED,
      completedAt: args.endsAt,
      outcome: OccurrenceOutcome.HELD,
      outcomeAt: args.endsAt,
      deliveredMinutes: 60,
      lostMinutes: 0,
    },
  });

  const shortAppointmentId = appointment.id.slice(0, 8);
  const payment = await prisma.payment.create({
    data: {
      amount: args.totalPricePaise,
      originalAmount: args.totalPricePaise,
      taxAmount: 0,
      currency: Currency.INR,
      paymentMethod: args.paymentMethod,
      paymentIntent: `pi_seed_${args.seedTag}_${shortAppointmentId}`,
      gatewayPaymentId: `pay_seed_${args.seedTag}_${shortAppointmentId}`,
      clientIdempotencyKey: `idem_seed_${args.seedTag}_${shortAppointmentId}`,
      paymentGateway: PaymentGateway.RAZORPAY,
      paymentStatus: PaymentStatus.SUCCEEDED,
      capturedAt: args.startsAt,
      isMockPayment: true,
      userId: args.learnerUserId,
      appointmentId: appointment.id,
      organizationId: args.appointmentOrgId,
      hostOrganizationId: args.hostOrgId,
      billingAccountId: args.billingAccountId,
      legs: {
        create: args.legs,
      },
    },
  });

  await prisma.appointmentParticipant.createMany({
    data: [
      {
        appointmentId: appointment.id,
        userId: args.learnerUserId,
        role: ParticipantRole.CONSULTEE,
        status: ParticipantStatus.ATTENDED,
        paymentId: payment.id,
        organizationId: args.learnerOrgId,
        sessionsPurchased: 1,
      },
      {
        appointmentId: appointment.id,
        userId: args.expertUserId,
        role: ParticipantRole.CONSULTANT,
        status: ParticipantStatus.ATTENDED,
        organizationId: args.hostOrgId,
      },
    ],
  });

  await prisma.organizationEarnings.create({
    data: {
      organizationId: args.hostOrgId,
      paymentId: payment.id,
      consultantProfileId: args.consultantProfileId,
      role: EarningRole.OWNER,
      grossAmountPaise: args.totalPricePaise,
      platformFeePaise: args.platformFeePaise,
      orgSharePaise: args.orgSharePaise,
      consultantSharePaise: args.consultantSharePaise,
      status: EarningStatus.READY,
      holdUntil: new Date(args.endsAt.getTime() + dayMs),
    },
  });

  await prisma.appointmentFeedback.create({
    data: {
      appointmentId: appointment.id,
      appointmentOccurrenceId: occurrence.id,
      consultantProfileId: args.consultantProfileId,
      userId: args.learnerUserId,
      organizationId: args.appointmentOrgId,
      rating: args.rating,
      comment: args.comment,
      raterRole: AppointmentFeedbackRole.CONSULTEE,
    },
  });

  return { appointment, occurrence, payment };
}

/**
 * Seeds organization-scoped Appointments, AppointmentOccurrences,
 * AppointmentParticipants, Payments + PaymentLegs, BookingUtilizations,
 * OverageEvents, OrganizationEarnings (with consultantProfileId), and
 * AppointmentFeedback across BUYER (Wipro), HOST (LearnPro Academy), and
 * HYBRID (IIT Madras) organizations so local dev and E2E suites have
 * non-empty datasets for `/sessions`, `/analytics`, `/utilization`,
 * `/earnings`, and `/reports`.
 *
 * Uses historical dates 120–140 days in the past (outside 6a's [-90, +90]d
 * window) so the confirmed-occurrence GIST exclusion constraint never collides
 * with randomly generated personal bookings.
 */
export async function createOrgAppointmentsAndFeedback(): Promise<void> {
  console.log(
    "Creating organization-scoped appointments, utilization, earnings, and feedback...",
  );

  const [wipro, learnPro, iitMadras] = await Promise.all([
    prisma.organization.findUnique({
      where: { slug: "wipro" },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          include: {
            user: {
              include: {
                consulteeProfile: true,
              },
            },
            programAssignments: {
              where: { status: "ACTIVE" },
              include: { program: { include: { licensedSeatConfig: true } } },
            },
          },
        },
      },
    }),
    prisma.organization.findUnique({
      where: { slug: "learnpro-academy" },
      include: {
        memberships: {
          where: {
            role: "EXPERT",
            status: "ACTIVE",
            consultantProfileId: { not: null },
          },
          include: {
            user: true,
            consultantProfile: {
              include: {
                consultationPlans: { take: 1 },
              },
            },
          },
        },
      },
    }),
    prisma.organization.findUnique({
      where: { slug: "iit-madras" },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          include: {
            user: {
              include: {
                consulteeProfile: true,
              },
            },
            consultantProfile: {
              include: {
                consultationPlans: { take: 1 },
              },
            },
            programAssignments: {
              where: { status: "ACTIVE" },
              include: { program: { include: { creditPoolConfig: true } } },
            },
          },
        },
      },
    }),
  ]);

  if (!wipro || !learnPro || !iitMadras) {
    console.warn(
      "[14c] Skipping org appointment seed — canonical enterprise orgs not present.",
    );
    return;
  }

  // Helper to ensure a consultant has a matching ConsultationPlan for the
  // target organization and price.
  async function ensureConsultationPlan(
    consultantProfileId: string,
    title: string,
    pricePaise: number,
    organizationId?: string,
  ) {
    const existing = await prisma.consultationPlan.findFirst({
      where: {
        consultantProfileId,
        organizationId: organizationId ?? null,
        price: pricePaise,
        archivedAt: null,
      },
      select: { id: true, price: true },
    });
    if (existing) return existing;
    return await prisma.consultationPlan.create({
      data: {
        consultantProfileId,
        organizationId: organizationId ?? null,
        title,
        description: "Enterprise coaching consultation session.",
        durationInHours: 1,
        price: pricePaise,
        priceCurrency: Currency.INR,
        language: "English",
        level: "ADVANCED",
        visibility: organizationId ? "ORG_AND_PUBLIC" : "PUBLIC",
      },
      select: { id: true, price: true },
    });
  }

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;

  // -------------------------------------------------------------------------
  // 1. Wipro (BUYER) learners booking LearnPro (HOST) experts
  //    - Booking 1: Within ₹10K price cap (₹8,000)
  //    - Booking 2: Exceeds ₹10K price cap (₹12,000 -> ₹2,000 CHARGE_ORG overage)
  // -------------------------------------------------------------------------
  const wiproLearners = wipro.memberships.filter(
    (m) =>
      m.role === "LEARNER" &&
      m.user.consulteeProfile &&
      m.programAssignments.length > 0,
  );
  const learnProExperts = learnPro.memberships.filter(
    (m) => m.consultantProfile !== null,
  );

  for (
    let i = 0;
    i < Math.min(2, wiproLearners.length, learnProExperts.length);
    i++
  ) {
    const learnerMembership = wiproLearners[i];
    const consulteeProfile = learnerMembership.user.consulteeProfile!;
    const assignment = learnerMembership.programAssignments[0];
    const expertMembership = learnProExperts[i];
    const consultantProfile = expertMembership.consultantProfile!;

    const isOverage = i === 1;
    const baseCoveredPaise = 8_000 * 100;
    const overagePaise = isOverage ? 2_000 * 100 : 0;
    const totalPricePaise = isOverage ? 12_000 * 100 : baseCoveredPaise;
    const coveredAccrualPaise = totalPricePaise - overagePaise;

    const plan = await ensureConsultationPlan(
      consultantProfile.id,
      `LearnPro Executive Advisory #${i + 1}`,
      totalPricePaise,
      learnPro.id,
    );

    const startsAt = new Date(
      now.getTime() - (135 - i * 2) * dayMs + 10 * hourMs,
    );
    const endsAt = new Date(startsAt.getTime() + hourMs);
    const platformFeePaise = Math.round(totalPricePaise * 0.1);
    const orgSharePaise = Math.round(totalPricePaise * 0.1);
    const consultantSharePaise =
      totalPricePaise - platformFeePaise - orgSharePaise;

    const { appointment, payment } = await seedCompletedOrgConsultation({
      planId: plan.id,
      consulteeProfileId: consulteeProfile.id,
      learnerUserId: learnerMembership.userId,
      learnerOrgId: wipro.id,
      expertUserId: expertMembership.userId,
      consultantProfileId: consultantProfile.id,
      hostOrgId: learnPro.id,
      appointmentOrgId: wipro.id,
      billingAccountId: wipro.billingAccountId,
      startsAt,
      endsAt,
      requestedAt: new Date(startsAt.getTime() - 3 * dayMs),
      totalPricePaise,
      paymentMethod: "INVOICE",
      seedTag: `wipro_org_${i + 1}`,
      legs: isOverage
        ? [
            {
              source: PaymentLegSource.INVOICE_ACCRUAL,
              amountPaise: coveredAccrualPaise,
              sourceRef: assignment.id,
            },
            {
              source: PaymentLegSource.OVERAGE_INVOICE_ACCRUAL,
              amountPaise: overagePaise,
              sourceRef: assignment.id,
            },
          ]
        : [
            {
              source: PaymentLegSource.INVOICE_ACCRUAL,
              amountPaise: totalPricePaise,
              sourceRef: assignment.id,
            },
          ],
      platformFeePaise,
      orgSharePaise,
      consultantSharePaise,
      rating: 5 - i,
      comment:
        i === 0
          ? "Actionable guidance on distributed systems leadership."
          : "Deep-dive architecture review exceeded expectations.",
    });

    const utilization = await prisma.bookingUtilization.create({
      data: {
        programAssignmentId: assignment.id,
        paymentId: payment.id,
        engagementsConsumed: 1,
        priceAtBookingPaise: totalPricePaise,
        wasOverage: isOverage,
        platformBpsAtBooking: 1000,
        orgBpsAtBooking: 1000,
        consultantBpsAtBooking: 8000,
        appointmentIds: [appointment.id],
      },
    });

    await prisma.usageLedgerEntry.create({
      data: {
        programAssignmentId: assignment.id,
        membershipId: learnerMembership.id,
        paymentId: payment.id,
        engagementsConsumed: 1,
        minutesConsumed: 60,
        priceAtBookingPaise: totalPricePaise,
        wasOverage: isOverage,
        notes: "Seed: Wipro enterprise consultation booking",
      },
    });

    await prisma.programAssignment.update({
      where: { id: assignment.id },
      data: {
        engagementsUsed: { increment: 1 },
        ...(isOverage ? { overageCount: { increment: 1 } } : {}),
      },
    });

    if (isOverage) {
      await prisma.overageEvent.create({
        data: {
          programAssignmentId: assignment.id,
          bookingUtilizationId: utilization.id,
          overageBehavior: OverageBehavior.CHARGE_ORG,
          basePaise: overagePaise,
          surchargePaise: 0,
          marginalPaise: overagePaise,
          currency: Currency.INR,
          chargeStatus: OverageChargeStatus.ACCRUED,
          paymentId: payment.id,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. LearnPro Academy (HOST) direct org-tagged session + feedback
  // -------------------------------------------------------------------------
  if (wiproLearners.length > 0 && learnProExperts.length > 0) {
    const learnerUser = wiproLearners[0].user;
    const consulteeProfile = learnerUser.consulteeProfile!;
    const hostExpert =
      learnProExperts[Math.min(2, learnProExperts.length - 1)];
    const consultantProfile = hostExpert.consultantProfile!;
    const pricePaise = 6_000 * 100;

    const plan = await ensureConsultationPlan(
      consultantProfile.id,
      "LearnPro Specialist Coaching",
      pricePaise,
      learnPro.id,
    );

    const startsAt = new Date(now.getTime() - 128 * dayMs + 14 * hourMs);
    const endsAt = new Date(startsAt.getTime() + hourMs);

    await seedCompletedOrgConsultation({
      planId: plan.id,
      consulteeProfileId: consulteeProfile.id,
      learnerUserId: learnerUser.id,
      learnerOrgId: learnPro.id,
      expertUserId: hostExpert.userId,
      consultantProfileId: consultantProfile.id,
      hostOrgId: learnPro.id,
      appointmentOrgId: learnPro.id,
      billingAccountId: null,
      startsAt,
      endsAt,
      requestedAt: new Date(startsAt.getTime() - 2 * dayMs),
      totalPricePaise: pricePaise,
      paymentMethod: "CARD",
      seedTag: "learnpro_host",
      legs: [
        {
          source: PaymentLegSource.CARD,
          amountPaise: pricePaise,
          sourceRef: "pay_seed_learnpro_host",
        },
      ],
      platformFeePaise: Math.round(pricePaise * 0.1),
      orgSharePaise: Math.round(pricePaise * 0.1),
      consultantSharePaise: Math.round(pricePaise * 0.8),
      rating: 5,
      comment: "Clear, well-structured LearnPro coaching session.",
    });
  }

  // -------------------------------------------------------------------------
  // 3. IIT Madras (HYBRID) student booking an IIT professor via CREDIT_POOL
  // -------------------------------------------------------------------------
  const iitStudents = iitMadras.memberships.filter(
    (m) =>
      m.role === "LEARNER" &&
      m.user.consulteeProfile &&
      m.programAssignments.length > 0,
  );
  const iitExperts = iitMadras.memberships.filter(
    (m) => m.role === "EXPERT" && m.consultantProfile !== null,
  );

  if (iitStudents.length > 0 && iitExperts.length > 0) {
    const studentMembership = iitStudents[0];
    const consulteeProfile = studentMembership.user.consulteeProfile!;
    const studentAssignment = studentMembership.programAssignments[0];
    const profMembership = iitExperts[0];
    const profProfile = profMembership.consultantProfile!;
    const pricePaise = 5_000 * 100; // ₹5,000 = 5,000 credits

    const plan = await ensureConsultationPlan(
      profProfile.id,
      "IIT Madras Faculty Research Mentorship",
      pricePaise,
      iitMadras.id,
    );

    const startsAt = new Date(now.getTime() - 124 * dayMs + 11 * hourMs);
    const endsAt = new Date(startsAt.getTime() + hourMs);
    const platformFeePaise = Math.round(pricePaise * 0.15);
    const orgSharePaise = Math.round(pricePaise * 0.85);

    const { appointment, payment } = await seedCompletedOrgConsultation({
      planId: plan.id,
      consulteeProfileId: consulteeProfile.id,
      learnerUserId: studentMembership.userId,
      learnerOrgId: iitMadras.id,
      expertUserId: profMembership.userId,
      consultantProfileId: profProfile.id,
      hostOrgId: iitMadras.id,
      appointmentOrgId: iitMadras.id,
      billingAccountId: iitMadras.billingAccountId,
      startsAt,
      endsAt,
      requestedAt: new Date(startsAt.getTime() - 2 * dayMs),
      totalPricePaise: pricePaise,
      paymentMethod: "WALLET",
      seedTag: "iitm_hybrid",
      legs: [
        {
          source: PaymentLegSource.WALLET,
          amountPaise: pricePaise,
          sourceRef: studentAssignment.id,
        },
      ],
      platformFeePaise,
      orgSharePaise,
      consultantSharePaise: 0,
      rating: 5,
      comment: "Invaluable faculty mentorship on our thesis methodology.",
    });

    if (iitMadras.billingAccountId) {
      await postLedgerTxn(prisma, {
        idempotencyKey: `seed-iitm-booking:${payment.id}`,
        kind: "BOOKING",
        paymentId: payment.id,
        postings: [
          {
            account: {
              kind: "WALLET",
              organizationId: iitMadras.id,
              currency: "INR",
            },
            direction: "DEBIT",
            amountPaise: pricePaise,
          },
          {
            account: { kind: "PLATFORM_FEE", currency: "INR" },
            direction: "CREDIT",
            amountPaise: platformFeePaise,
          },
          {
            account: {
              kind: "ORG_PAYABLE",
              organizationId: iitMadras.id,
              currency: "INR",
            },
            direction: "CREDIT",
            amountPaise: orgSharePaise,
          },
        ],
      });
      await prisma.billingAccount.update({
        where: { id: iitMadras.billingAccountId },
        data: { walletBalance: { decrement: pricePaise } },
      });
    }

    await prisma.bookingUtilization.create({
      data: {
        programAssignmentId: studentAssignment.id,
        paymentId: payment.id,
        engagementsConsumed: 1,
        priceAtBookingPaise: pricePaise,
        wasOverage: false,
        platformBpsAtBooking: 1500,
        orgBpsAtBooking: 8500,
        consultantBpsAtBooking: 0,
        appointmentIds: [appointment.id],
      },
    });

    await prisma.usageLedgerEntry.create({
      data: {
        programAssignmentId: studentAssignment.id,
        membershipId: studentMembership.id,
        paymentId: payment.id,
        engagementsConsumed: 1,
        minutesConsumed: 60,
        priceAtBookingPaise: pricePaise,
        wasOverage: false,
        notes: "Seed: IIT Madras credit-pool consultation booking",
      },
    });

    await prisma.programAssignment.update({
      where: { id: studentAssignment.id },
      data: {
        engagementsUsed: { increment: 1 },
        consumedPaise: { increment: pricePaise },
      },
    });
  }

  console.log(
    "✓ Seeded organization-scoped appointments, utilization, overages, earnings, and feedback",
  );
}
