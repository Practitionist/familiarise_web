/**
 * GET    /api/user/privacy/consent
 * POST   /api/user/privacy/consent
 * DELETE /api/user/privacy/consent?purposeCode=<code>
 *
 * Self-serve personal DPDP (India) consent management for Familiarise
 * (`dataFiduciary: "Familiarise"`), accessible to ALL authenticated users
 * (B2C consultees, consultants, org operators, staff) from
 * Settings → Account → Data consent.
 *
 * Two-Tier Consent Model (DPDP §6(4)–(6)):
 *   - Core Platform Purposes (`PRIMARY_PROCESSING`, `SESSION_BOOKING`,
 *     `STREAM_DATA_PROCESSING`): Required to operate an active account and
 *     deliver bookings. Withdrawing core consent requires closing/erasing the
 *     account (`DELETE /api/user/[id]`).
 *   - Optional Purposes (`MARKETING_COMMS`, `ANALYTICS`): Granular 1-click
 *     grant/withdraw at any time without affecting core account access.
 *     Toggling `MARKETING_COMMS` also synchronises
 *     `NotificationPreference.marketingEmails` and `CookiePreference.marketing`;
 *     toggling `ANALYTICS` synchronises `CookiePreference.analytics`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { buildConsentArtifact, withdrawConsent } from "@/lib/compliance/dpdp";
import {
  PURPOSE_CODES,
  SIGNUP_PURPOSES,
  normalizePurposeCode,
  type PurposeCode,
} from "@/lib/compliance/purpose-codes";

const CORE_PLATFORM_PURPOSES: ReadonlySet<PurposeCode> = new Set(
  SIGNUP_PURPOSES,
);

const LanguageSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "ISO 639-1/2 language code required")
  .default("en-IN");

const GrantBodySchema = z.object({
  purposeCodes: z.array(z.string().min(1).max(64)).min(1).max(10),
  language: LanguageSchema,
  version: z.coerce.number().int().min(1).default(1),
});

const WithdrawQuerySchema = z.object({
  purposeCode: z.string().min(1).max(64),
});

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const [consents, notificationPref, cookiePref] = await Promise.all([
    prisma.consentArtifact.findMany({
      where: {
        userId,
        dataFiduciary: "Familiarise",
      },
      orderBy: { grantedAt: "desc" },
      take: 100,
    }),
    prisma.notificationPreference.findUnique({
      where: { userId },
      select: { marketingEmails: true },
    }),
    prisma.cookiePreference.findUnique({
      where: { userId },
      select: { analytics: true, marketing: true },
    }),
  ]);

  return NextResponse.json({
    data: consents,
    preferences: {
      marketingEmails: notificationPref?.marketingEmails ?? false,
      cookieAnalytics: cookiePref?.analytics ?? false,
      cookieMarketing: cookiePref?.marketing ?? false,
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const raw = await req.json().catch(() => null);
  const parsed = GrantBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const normalized = parsed.data.purposeCodes.map((c) => ({
    raw: c,
    code: normalizePurposeCode(c),
  }));
  const unknown = normalized
    .filter((n) => n.code === undefined)
    .map((n) => n.raw);
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: "Unknown purpose code(s)", detail: { unknown } },
      { status: 400 },
    );
  }

  const purposeCodes = Array.from(
    new Set(normalized.map((n) => n.code as PurposeCode)),
  );

  const draft = buildConsentArtifact({
    userId,
    dataFiduciary: "Familiarise",
    purposeCodes,
    language: parsed.data.language,
    consentManager: null,
    version: parsed.data.version,
  });

  try {
    const consent = await prisma.$transaction(async (tx) => {
      const created = await tx.consentArtifact.create({ data: draft });

      // Sync downstream preference tables so marketing mailers and cookie gates
      // honour the DPDP consent grant immediately.
      if (purposeCodes.includes(PURPOSE_CODES.MARKETING_COMMS)) {
        await Promise.all([
          tx.notificationPreference.upsert({
            where: { userId },
            create: { userId, marketingEmails: true },
            update: { marketingEmails: true },
          }),
          tx.cookiePreference.upsert({
            where: { userId },
            create: { userId, marketing: true },
            update: { marketing: true },
          }),
        ]);
      }
      if (purposeCodes.includes(PURPOSE_CODES.ANALYTICS)) {
        await tx.cookiePreference.upsert({
          where: { userId },
          create: { userId, analytics: true },
          update: { analytics: true },
        });
      }

      return created;
    });

    return NextResponse.json({ consent }, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "compliance", op: "personalConsent.POST" } },
    );
    return NextResponse.json(
      { error: "Could not record your consent" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const url = new URL(req.url);
  const parsed = WithdrawQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const purposeCode = normalizePurposeCode(parsed.data.purposeCode);
  if (purposeCode === undefined) {
    return NextResponse.json(
      {
        error: "Unknown purpose code",
        detail: { purposeCode: parsed.data.purposeCode },
      },
      { status: 400 },
    );
  }

  // Two-Tier Consent Guard (DPDP §6(5)): Core platform purposes are required
  // to operate the account. Withdrawing them requires closing/erasing the account.
  if (CORE_PLATFORM_PURPOSES.has(purposeCode)) {
    return NextResponse.json(
      {
        error:
          "Core platform consent is required to operate your account. To withdraw core consent, use 'Withdraw core consent & delete account' below.",
        code: "CORE_CONSENT_REQUIRES_ACCOUNT_CLOSURE",
        purposeCode,
      },
      { status: 400 },
    );
  }

  try {
    const { withdrawnCount } = await withdrawConsent({ userId, purposeCode });

    if (purposeCode === PURPOSE_CODES.MARKETING_COMMS) {
      await Promise.all([
        prisma.notificationPreference.updateMany({
          where: { userId },
          data: { marketingEmails: false },
        }),
        prisma.cookiePreference.updateMany({
          where: { userId },
          data: { marketing: false },
        }),
      ]);
    }
    if (purposeCode === PURPOSE_CODES.ANALYTICS) {
      await prisma.cookiePreference.updateMany({
        where: { userId },
        data: { analytics: false },
      });
    }

    return NextResponse.json({ withdrawnCount, purposeCode });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "compliance", op: "personalConsent.DELETE" } },
    );
    return NextResponse.json(
      { error: "Could not withdraw your consent" },
      { status: 500 },
    );
  }
}
