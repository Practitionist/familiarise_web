import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { findUserIssues } from "@/lib/observability/sentry-issues";
import {
  personNamesMatch,
  verifiedPayoutHolderName,
} from "@/lib/payments/tax/pan-verification";

/**
 * #1527 Q5 — User 360: one person across every back-office queue. Ten rows
 * per section, one query per section, run one after another: PG_POOL_MAX=1
 * serialises them anyway, and a failed section should not hide the others.
 */

const TAKE = 10;

async function readProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      image: true,
      role: true,
      onboardingCompleted: true,
      createdAt: true,
      city: true,
      country: true,
      banned: true,
      banReason: true,
      banExpires: true,
      erasedAt: true,
      consultantProfile: {
        select: { id: true, headline: true, verificationStatus: true },
      },
      consulteeProfile: { select: { id: true } },
      staffProfile: { select: { id: true, department: true, position: true } },
      memberships: {
        take: TAKE,
        orderBy: { createdAt: "desc" },
        select: {
          role: true,
          status: true,
          organization: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/** The PAN state the 194-O rate reads, and the names the Verify PAN door compares. */
async function readPanState(consultantProfileId: string, name: string) {
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
    select: { panEncrypted: true, panLast4: true, panVerified: true },
  });
  const payoutHolderName = await verifiedPayoutHolderName(
    prisma,
    consultantProfileId,
  );
  let state: "VERIFIED" | "PENDING" | "NOT_PROVIDED" = "NOT_PROVIDED";
  if (taxInfo?.panEncrypted)
    state = taxInfo.panVerified ? "VERIFIED" : "PENDING";
  return {
    state,
    panLast4: taxInfo?.panLast4 ?? null,
    payoutHolderName,
    namesMatch: personNamesMatch(name, payoutHolderName),
  };
}

export async function readUser360(userId: string) {
  const profile = await readProfile(userId);
  if (!profile) return null;

  const bookings = await prisma.appointmentParticipant.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: {
      id: true,
      role: true,
      status: true,
      appointment: {
        select: { id: true, appointmentType: true, createdAt: true },
      },
    },
  });
  const payments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      createdAt: true,
    },
  });
  const tickets = await prisma.supportCase.findMany({
    where: { requesterUserId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: {
      id: true,
      referenceNumber: true,
      title: true,
      status: true,
      priority: true,
      createdAt: true,
    },
  });
  const reports = await prisma.moderationReport.findMany({
    where: { targetUserId: userId },
    orderBy: { createdAt: "desc" },
    take: TAKE,
    select: {
      id: true,
      type: true,
      status: true,
      reason: true,
      createdAt: true,
    },
  });
  const verifications = profile.consultantProfile
    ? await prisma.consultantProfileVerification.findMany({
        where: { consultantProfileId: profile.consultantProfile.id },
        orderBy: { submittedAt: "desc" },
        take: TAKE,
        select: {
          id: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          _count: { select: { documents: true } },
        },
      })
    : [];
  const pan = profile.consultantProfile
    ? await readPanState(profile.consultantProfile.id, profile.name)
    : null;

  // Sentry triage. The last thing that asks an external service, and the only
  // one that can fail, so it runs after every DB section has already resolved
  // and cannot take the page down with it — `findUserIssues` swallows its own
  // errors and returns `{ configured: false }`. Answers "which issues is this
  // person hitting", which is the question the other six sections cannot.
  const sentryIssues = await findUserIssues({ userId });

  // toPlain — money rows carry the result extension's symbols; the page
  // hands this to client components.
  return toPlain({
    profile,
    bookings,
    payments,
    tickets,
    reports,
    verifications,
    pan,
    sentryIssues,
  });
}

export type User360 = NonNullable<Awaited<ReturnType<typeof readUser360>>>;
