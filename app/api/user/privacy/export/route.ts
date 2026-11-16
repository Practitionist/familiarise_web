/**
 * GET /api/user/privacy/export
 *
 * Self-serve DPDP Act 2023 Section 11 ("Right to access information about
 * personal data") & GDPR Art. 15/20 machine-readable export.
 *
 * Returns a JSON bundle containing:
 *   1. `personalDataSummary` (§11(1)(a)): The user's account profile, role
 *      profiles, professional background, booking history, collaborations on
 *      other experts' plans, payments/invoices,
 *      support tickets, staff access to their booking chats, DPDP grievances,
 *      notification/cookie preferences, and the sign-in access log (start, end,
 *      end reason, IP address and user agent of each session).
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
import {
  OFFERED_PURPOSE_CODES,
  PURPOSE_CODE_META,
} from "@/lib/compliance/purpose-codes";
import { readSupportExport } from "@/lib/support/privacy-export";
import { readSessionAccessLog } from "@/lib/auth/session-access-log";
import {
  MEMBER_ROLE_LABEL,
  MEMBER_STATUS_LABEL,
} from "@/lib/labels/org-labels";
import { userRoleLabel } from "@/lib/labels/personal-dashboard";
import { bpsToPercent } from "@/lib/collaborators/rules";

/** Statute citations behind each plain sentence in `statutoryRetentionAndRightsInfo`. */
const RETENTION_LEGAL_BASIS = {
  optionalConsentWithdrawal: "DPDP Act 2023, section 6(4)",
  coreConsentWithdrawalAndErasure:
    "DPDP Act 2023, sections 6(4) to 6(6) and 12",
  statutoryTaxRetention:
    "Income-tax Act 1961, section 44AA and Rule 6F; CGST Act 2017, section 36; DPDP Act 2023, sections 12(3) and 8(7)(b)",
  securityLogRetention: "DPDP Rules 2025, Rule 8(3)",
  sessionAccessLogRetention: "CERT-In Directions of 28 April 2022",
  grievanceAndBoardAppeal:
    "DPDP Rules 2025, Rule 14(3); DPDP Act 2023, sections 13(3) and 27",
} as const;

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
      support,
      participations,
      sessionAccessLog,
      collaborationRows,
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
          adultConfirmedAt: true,
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
      readSupportExport(userId),
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
      readSessionAccessLog(userId),
      // The user's own invitations and places on other experts' plans, ended
      // ones included. Nothing about the inviter or the rest of the team.
      prisma.collaborator.findMany({
        where: { consultantProfile: { userId } },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          role: true,
          status: true,
          revenueShareBps: true,
          createdAt: true,
          acceptedAt: true,
          endedAt: true,
          webinarPlan: { select: { title: true } },
          classPlan: { select: { title: true } },
        },
      }),
    ]);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const collaborations = collaborationRows.map((c) => ({
      id: c.id,
      planType: c.webinarPlan ? "WEBINAR" : "CLASS",
      planTitle: c.webinarPlan?.title ?? c.classPlan?.title ?? null,
      role: c.role,
      status: c.status,
      revenueSharePercent: bpsToPercent(c.revenueShareBps),
      invitedAt: c.createdAt,
      acceptedAt: c.acceptedAt,
      endedAt: c.endedAt,
    }));

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
        entityName: "Supabase Inc. (Cloud PostgreSQL & Storage)",
        role: "Service provider that handles data for us",
        legalRole: "Data Processor",
        sharedData: [
          "Account profile, authentication records, booking history, and encrypted verification documents",
        ],
        purpose: "Stores your account data and files so the service can run.",
        purposeCodes: ["PRIMARY_PROCESSING"],
        sharedForThisAccount: true,
      },
      {
        entityName: "Netlify, Inc. (Hosting & Content Delivery)",
        role: "Service provider that handles data for us",
        legalRole: "Data Processor",
        sharedData: [
          "Technical details of each request, such as your IP address and browser",
        ],
        purpose: "Runs the website and delivers pages to you.",
        purposeCodes: ["PRIMARY_PROCESSING"],
        sharedForThisAccount: true,
      },
      {
        entityName: "Cloudflare, Inc. (R2 Storage & Turnstile)",
        role: "Service provider that handles data for us",
        legalRole: "Data Processor",
        sharedData: [
          "Recordings of sessions you took part in and files you sold or bought, where they exist, and browser signals for the bot check on sign-up and password-reset forms",
        ],
        purpose:
          "Stores recordings and files, and stops bots on the sign-up and password-reset forms.",
        purposeCodes: ["STREAM_DATA_PROCESSING", "PRIMARY_PROCESSING"],
        sharedForThisAccount: true,
      },
      {
        entityName: "Razorpay Software Pvt. Ltd.",
        role: "Service provider for payments and payouts",
        legalRole: "Data Processor (Payment Gateway & Payouts)",
        sharedData: hasPayments
          ? [
              "Buyer/payee identifier, transaction amount, payment instrument reference, and invoice metadata",
            ]
          : ["No payment transactions recorded for this account yet"],
        purpose:
          "Collects payments, sends refunds and expert payouts, and supports tax invoices.",
        purposeCodes: ["PRIMARY_PROCESSING"],
        sharedForThisAccount: hasPayments,
      },
      {
        entityName: "Stream.io Inc. (GetStream)",
        role: "Service provider for live video and chat",
        legalRole: "Data Processor (Live Video & Chat)",
        sharedData: hasVideoOrBookings
          ? [
              "Internal user ID, display name, profile avatar, and session channel membership",
            ]
          : ["Synchronised only when you join a chat channel or video session"],
        purpose: "Runs live video calls and chat messages.",
        purposeCodes: ["STREAM_DATA_PROCESSING"],
        sharedForThisAccount: hasVideoOrBookings,
      },
      {
        entityName: "Resend Inc. & Novu",
        role: "Service provider for emails and notifications",
        legalRole: "Data Processor (Transactional & Notification Delivery)",
        sharedData: [
          "Email address, display name, and booking/support notification templates",
        ],
        purpose:
          "Sends verification emails, booking reminders and support updates, and marketing emails only if you agreed.",
        purposeCodes: ["PRIMARY_PROCESSING"],
        sharedForThisAccount: true,
      },
      {
        entityName: "Functional Software, Inc. (Sentry — us.sentry.io)",
        role: "Service provider for security and error reports",
        legalRole: "Data Processor (Security & Reliability Diagnostics)",
        sharedData: [
          `A scrambled identifier that can't be traced back to you (${sentryPseudonymousToken}), your account type (${userRoleLabel(user.role)}), and error reports with personal details removed. We do not send your email, name, phone number or page text.`,
        ],
        purpose:
          "Helps us keep the service secure, find faults and fix problems you report.",
        purposeCodes: ["PRIMARY_PROCESSING"],
        legalBasis:
          "DPDP Act 2023, section 8(5); DPDP Rules 2025, Rule 6(1)(a)",
        sharedForThisAccount: true,
      },
      ...user.memberships.map((m) => ({
        entityName: `Organisation: ${m.organization.name}`,
        role: "Organisation you belong to",
        legalRole: "Data Fiduciary",
        sharedData: [
          `Your role (${MEMBER_ROLE_LABEL[m.role]}), your membership status (${MEMBER_STATUS_LABEL[m.status]}), and your sessions that the organisation pays for`,
        ],
        purpose:
          "Lets the organisation manage its members and sponsor their learning and mentoring sessions.",
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
          adultConfirmedAt: user.adultConfirmedAt,
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
          collaborations,
          payments,
          consumerInvoices,
          ...support,
          dpdpGrievances: grievances,
          sessionAccessLog: sessionAccessLog.rows,
          sessionAccessLogTruncated: sessionAccessLog.truncated,
        },
      },
      processingActivities: Object.fromEntries(
        OFFERED_PURPOSE_CODES.map((code) => [code, PURPOSE_CODE_META[code]]),
      ),
      sharedWithDataProcessors,
      consentHistory: consents,
      statutoryRetentionAndRightsInfo: {
        optionalConsentWithdrawal:
          "You can give or withdraw your optional marketing consent, which also covers the Familiarise newsletter, at any time in Settings, then Account, then Data consent. Your account keeps working either way.",
        coreConsentWithdrawalAndErasure:
          "If you withdraw the consent our core service needs, we close your account and remove your personal details.",
        statutoryTaxRetention:
          "We must keep payment records, tax invoices, expert payouts and tax-deduction records for 7 to 8 years, so these are kept even after you close your account.",
        securityLogRetention:
          "We keep security and processing logs, with no direct identifiers, for at least 1 year.",
        sessionAccessLogRetention:
          "For 180 days after each sign-in session ends, we keep its IP address, device, start time and end time, because Indian cyber-security rules require it. Closing your account unlinks these rows from you, and they are deleted when the 180 days pass. This file lists your newest 500 sessions; sessionAccessLogTruncated is true when older ones exist.",
        grievanceAndBoardAppeal:
          "You can raise a complaint in Settings, then Account, then Data protection grievance, and we will resolve it within 90 days. If it is still unresolved, you can take it to the Data Protection Board of India.",
        legalBasis: RETENTION_LEGAL_BASIS,
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
