import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { reportSentryError } from "@/lib/observability/report";
import { findUserIssues } from "@/lib/observability/sentry-issues";
import {
  personNamesMatch,
  verifiedPayoutHolderName,
} from "@/lib/payments/tax/pan-verification";

/**
 * User 360: one person across every back-office queue. Ten rows per section,
 * newest first with an id tie-break, one query per section, run one after
 * another (PG_POOL_MAX=1 serialises them anyway). A section that fails reads
 * as failed on its own; the failures are reported once per page.
 */

const TAKE = 10;

/** A section's rows, or `failed` when its read threw. */
export interface SectionRows<T> {
  rows: T[];
  failed: boolean;
}

async function readProfile(userId: string) {
  return prisma.user.findUnique({
    relationLoadStrategy: "join",
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
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
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

  const failures: { section: string; error: unknown }[] = [];
  const section = async <T>(
    name: string,
    read: () => Promise<T[]>,
  ): Promise<SectionRows<T>> => {
    try {
      return { rows: await read(), failed: false };
    } catch (error) {
      failures.push({ section: name, error });
      return { rows: [], failed: true };
    }
  };
  const newestFirst = [{ createdAt: "desc" as const }, { id: "asc" as const }];

  const bookings = await section("bookings", () =>
    prisma.appointmentParticipant.findMany({
      relationLoadStrategy: "join",
      where: { userId },
      orderBy: newestFirst,
      take: TAKE,
      select: {
        id: true,
        role: true,
        status: true,
        appointment: {
          select: { id: true, appointmentType: true, createdAt: true },
        },
      },
    }),
  );
  const payments = await section("payments", () =>
    prisma.payment.findMany({
      where: { userId },
      orderBy: newestFirst,
      take: TAKE,
      select: {
        id: true,
        amount: true,
        currency: true,
        paymentStatus: true,
        paymentGateway: true,
        createdAt: true,
      },
    }),
  );
  const tickets = await section("tickets", () =>
    prisma.supportCase.findMany({
      where: { requesterUserId: userId, deletedAt: null },
      orderBy: newestFirst,
      take: TAKE,
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        status: true,
        priority: true,
        createdAt: true,
      },
    }),
  );
  const reports = await section("reports", () =>
    prisma.moderationReport.findMany({
      where: { targetUserId: userId },
      orderBy: newestFirst,
      take: TAKE,
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
  );
  const consultantProfileId = profile.consultantProfile?.id;
  const verifications = await section("verifications", async () =>
    consultantProfileId
      ? prisma.consultantProfileVerification.findMany({
          where: { consultantProfileId },
          orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
          take: TAKE,
          select: {
            id: true,
            status: true,
            submittedAt: true,
            reviewedAt: true,
            _count: { select: { documents: true } },
          },
        })
      : [],
  );
  const panRead = await section("pan", async () =>
    consultantProfileId
      ? [await readPanState(consultantProfileId, profile.name)]
      : [],
  );

  if (failures.length > 0) {
    reportSentryError(failures[0].error, {
      subsystem: "admin",
      op: "user-360.sections",
      extra: { userId, failed: failures.map((f) => f.section) },
    });
  }

  // Sentry triage. The last thing that asks an external service; it runs
  // after every DB section and swallows its own errors, so it cannot take the
  // page down. It answers "which issues is this person hitting".
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
    pan: panRead.rows[0] ?? null,
    panFailed: panRead.failed,
    sentryIssues,
  });
}

export type User360 = NonNullable<Awaited<ReturnType<typeof readUser360>>>;
