/**
 * GET /api/user/privacy/export
 *
 * Self-serve DPDP Act 2023 Section 11 ("Right to access information about
 * personal data") & GDPR Art. 15/20 machine-readable export.
 *
 * Returns a JSON bundle containing:
 *   1. `personalDataSummary` (§11(1)(a)): The user's account profile, role
 *      profiles, professional background, booking history, payments/invoices,
 *      support tickets, DPDP grievances, and notification/cookie preferences.
 *   2. `processingActivities` (§11(1)(a)): Itemised purposes and legal bases
 *      under which Familiarise processes the user's personal data.
 *   3. `sharedWithDataProcessors` (§11(1)(b)): Identities of all Data
 *      Processors and Data Fiduciaries with whom the user's personal data has
 *      been shared, along with a description of the personal data shared
 *      (dynamically tailored to the user's actual bookings, payments, org
 *      memberships, and pseudonymous Sentry telemetry token `ust_<hash>`).
 *   4. `consentHistory`: All `ConsentArtifact` records (granted & withdrawn).
 *   5. `statutoryRetentionAndRightsInfo`: Clear disclosure of Indian statutory
 *      retention obligations (Income Tax Act §44AA / CGST Act §36 7–8 yr tax
 *      records, DPDP Rule 8(3) 1-yr security logs) and how to exercise
 *      withdrawal, erasure, or DPBI grievance appeal rights.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { resolveSentryUserId } from "@/lib/observability/identity";
import { PURPOSE_CODE_META } from "@/lib/compliance/purpose-codes";

export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const [
      user,
      consents,
      grievances,
      payments,
      rawConsumerInvoices,
      supportTickets,
      participations,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          phone: true,
          address: true,
          timezone: true,
          role: true,
          dateOfBirth: true,
          gender: true,
          city: true,
          country: true,
          linkedinUrl: true,
          bio: true,
          onboardingCompleted: true,
          termsAcceptedAt: true,
          privacyAcceptedAt: true,
          razorpayCustomerId: true,
          workExperiences: {
            select: {
              company: true,
              title: true,
              location: true,
              startDate: true,
              endDate: true,
              isCurrent: true,
            },
          },
          education: {
            select: {
              institution: true,
              degree: true,
              fieldOfStudy: true,
              startYear: true,
              endYear: true,
            },
          },
          certifications: {
            select: {
              name: true,
              issuingOrganization: true,
              issueDate: true,
              expiryDate: true,
            },
          },
          cookiePreferences: {
            select: {
              essential: true,
              analytics: true,
              marketing: true,
              functional: true,
              consentGivenAt: true,
              consentUpdatedAt: true,
            },
          },
          notificationPreferences: {
            select: {
              allNotifications: true,
              inAppEnabled: true,
              emailEnabled: true,
              pushEnabled: true,
              appointmentReminders: true,
              paymentNotifications: true,
              supportUpdates: true,
              feedbackAlerts: true,
              trialNotifications: true,
              subscriptionAlerts: true,
              marketingEmails: true,
            },
          },
          consulteeProfile: {
            select: {
              id: true,
              aboutMe: true,
              preferredLanguage: true,
              goals: true,
              careerStage: true,
              skillsToDevelop: true,
              budgetPreference: true,
            },
          },
          consultantProfile: {
            select: {
              id: true,
              headline: true,
              description: true,
              experience: true,
              scheduleType: true,
              languages: true,
              toolsAndTechnologies: true,
              mentoringStyle: true,
              offeringFormats: true,
              verificationStatus: true,
              createdAt: true,
            },
          },
          memberships: {
            select: {
              id: true,
              role: true,
              status: true,
              departmentLabel: true,
              createdAt: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },
        },
      }),
      prisma.consentArtifact.findMany({
        where: { userId },
        orderBy: { grantedAt: "desc" },
        select: {
          id: true,
          dataFiduciary: true,
          purposeCodes: true,
          language: true,
          version: true,
          grantedAt: true,
          withdrawnAt: true,
          auditRetainedUntil: true,
          hash: true,
        },
      }),
      prisma.dpdpGrievance.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          subject: true,
          description: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
      prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          paymentGateway: true,
          createdAt: true,
        },
      }),
      prisma.consumerInvoice.findMany({
        where: { userId },
        orderBy: { issuedAt: "desc" },
        take: 200,
        select: {
          id: true,
          invoiceNumber: true,
          totalPaise: true,
          currency: true,
          issuedAt: true,
        },
      }),
      prisma.supportTicket.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          title: true,
          category: true,
          priority: true,
          status: true,
          createdAt: true,
        },
      }),
      prisma.appointmentParticipant.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          appointmentId: true,
          role: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const consumerInvoices = rawConsumerInvoices.map((inv) => ({
      ...inv,
      totalPaise: Number(inv.totalPaise),
    }));

    const sentryPseudonymousToken = resolveSentryUserId(userId);
    const hasPayments = payments.length > 0 || Boolean(user.razorpayCustomerId);
    const hasVideoOrBookings =
      participations.length > 0 || Boolean(user.consultantProfile);

    // DPDP §11(1)(b): Identities of all other Data Fiduciaries and Data
    // Processors with whom the personal data has been shared, along with a
    // description of the personal data shared.
    const sharedWithDataProcessors = [
      {
        entityName: "Supabase Inc. / Neon Inc. (Cloud PostgreSQL & Storage)",
        role: "Data Processor",
        sharedData: [
          "Account profile, authentication records, booking history, and encrypted verification documents",
        ],
        purpose:
          "Primary database hosting, transactional persistence, and file storage (PRIMARY_PROCESSING)",
        sharedForThisAccount: true,
      },
      {
        entityName: "Razorpay Software Pvt. Ltd. / Stripe Inc.",
        role: "Data Processor (Payment Gateway & Payouts)",
        sharedData: hasPayments
          ? [
              "Buyer/payee identifier, transaction amount, payment instrument reference, and invoice metadata",
            ]
          : ["No payment transactions recorded for this account yet"],
        purpose:
          "Payment collection, refunds, consultant payouts, and statutory tax invoicing (PRIMARY_PROCESSING)",
        sharedForThisAccount: hasPayments,
      },
      {
        entityName: "Stream.io Inc. (GetStream)",
        role: "Data Processor (Live Video & Chat)",
        sharedData: hasVideoOrBookings
          ? [
              "Internal user ID, display name, profile avatar, and session channel membership",
            ]
          : ["Synchronised only when you join a chat channel or video session"],
        purpose:
          "Real-time consultation video calls and messaging (STREAM_DATA_PROCESSING)",
        sharedForThisAccount: hasVideoOrBookings,
      },
      {
        entityName: "Resend Inc. & Novu",
        role: "Data Processor (Transactional & Notification Delivery)",
        sharedData: [
          "Email address, display name, and booking/support notification templates",
        ],
        purpose:
          "Verification emails, booking reminders, support updates, and (only if consented) marketing emails",
        sharedForThisAccount: true,
      },
      {
        entityName: "Functional Software, Inc. (Sentry — us.sentry.io)",
        role: "Data Processor (Security & Reliability Diagnostics)",
        sharedData: [
          `One-way salted HMAC-SHA256 virtual token (${sentryPseudonymousToken}), user role (${user.role}), and scrubbed error/trace diagnostics. Zero raw PII (no email, name, phone, or unmasked page text).`,
        ],
        purpose:
          "Platform security safeguards, deadlock/error diagnostics, and customer support troubleshooting under DPDP §8(5) & Rule 6(1)(a)",
        sharedForThisAccount: true,
      },
      ...user.memberships.map((m) => ({
        entityName: `Organization: ${m.organization.name} (${m.organization.slug})`,
        role: "Data Fiduciary / Enterprise Workspace",
        sharedData: [
          `Membership role (${m.role}), status (${m.status}), and organisation-sponsored session participation`,
        ],
        purpose:
          "Enterprise workspace membership and organisation-sponsored learning/mentorship",
        sharedForThisAccount: true,
      })),
    ];

    const exportPayload = {
      schemaVersion: "dpdp-2023-s11-v1",
      exportedAt: new Date().toISOString(),
      dataFiduciary: {
        name: "Familiarise",
        grievanceEndpoint: "/api/compliance/grievances",
        settingsPrivacyUrl: "/dashboard/account#data-consent",
      },
      personalDataSummary: {
        profile: {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          phone: user.phone,
          address: user.address,
          timezone: user.timezone,
          role: user.role,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          city: user.city,
          country: user.country,
          linkedinUrl: user.linkedinUrl,
          bio: user.bio,
          onboardingCompleted: user.onboardingCompleted,
          termsAcceptedAt: user.termsAcceptedAt,
          privacyAcceptedAt: user.privacyAcceptedAt,
          pseudonymousTelemetryToken: sentryPseudonymousToken,
        },
        consulteeProfile: user.consulteeProfile,
        consultantProfile: user.consultantProfile,
        professionalBackground: {
          workExperiences: user.workExperiences,
          education: user.education,
          certifications: user.certifications,
        },
        organizationMemberships: user.memberships,
        preferences: {
          cookies: user.cookiePreferences,
          notifications: user.notificationPreferences,
        },
        activitySummary: {
          appointmentParticipations: participations,
          payments,
          consumerInvoices,
          supportTickets,
          dpdpGrievances: grievances,
        },
      },
      processingActivities: PURPOSE_CODE_META,
      sharedWithDataProcessors,
      consentHistory: consents,
      statutoryRetentionAndRightsInfo: {
        optionalConsentWithdrawal:
          "You may grant or withdraw optional consents (MARKETING_COMMS, ANALYTICS) at any time in Settings -> Account -> Data consent without affecting your core account.",
        coreConsentWithdrawalAndErasure:
          "Withdrawing core platform consent (PRIMARY_PROCESSING, SESSION_BOOKING, STREAM_DATA_PROCESSING) closes your account and scrubs your personal identifiers under DPDP §6(4)-(6) and §12.",
        statutoryTaxRetention:
          "Financial ledger rows, tax invoices, consultant payouts, and TDS/GST records are retained for 7-8 years under the Income Tax Act, 1961 (§44AA / Rule 6F) and CGST Act, 2017 (§36), as required by DPDP §12(3) and §8(7)(b).",
        securityLogRetention:
          "Pseudonymous security and processing logs are retained for at least 1 year under Rule 8(3) of the DPDP Rules, 2025.",
        grievanceAndBoardAppeal:
          "You may file a grievance in Settings -> Account -> Data protection grievance (resolved within 90 days per Rule 14(3)) and escalate unresolved complaints to the Data Protection Board of India under DPDP §13(3) and §27.",
      },
    };

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="familiarise-data-summary-${userId.slice(0, 8)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "compliance", op: "privacyExport.GET" } },
    );
    return NextResponse.json(
      { error: "Could not generate your data export" },
      { status: 500 },
    );
  }
}
