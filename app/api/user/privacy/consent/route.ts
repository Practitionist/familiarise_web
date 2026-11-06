import {
  readCookiePreferences,
  saveCookiePreferences,
} from "@/lib/compliance/cookie-preferences";
import { marketingConsentWhere } from "@/lib/compliance/marketing-policy";
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
 *     Toggling `MARKETING_COMMS` synchronises marketing email consent and enrollment;
 *     toggling `ANALYTICS` synchronises `CookiePreference.analytics`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { attemptSubscriberSync } from "@/lib/novu/subscriber";
import { requireApiAuth } from "@/lib/auth-helpers";
import { buildConsentArtifact, withdrawConsent } from "@/lib/compliance/dpdp";
import {
  grantMarketingConsent,
  withdrawMarketingConsent,
} from "@/lib/compliance/marketing-consent";
import {
  PURPOSE_CODES,
  TERMS_VERSION,
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
  version: z.literal(TERMS_VERSION).default(TERMS_VERSION),
});

const WithdrawQuerySchema = z.object({
  purposeCode: z.string().min(1).max(64),
});

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const [consents, notificationPref, cookiePref, marketingConsent] =
    await Promise.all([
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
      readCookiePreferences(prisma, { userId }),
      prisma.consentArtifact.findFirst({
        where: { userId, ...marketingConsentWhere() },
        select: { id: true },
      }),
    ]);

  return NextResponse.json({
    data: consents,
    preferences: {
      marketingEmails: Boolean(
        notificationPref?.marketingEmails && marketingConsent,
      ),
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
    new Set(normalized.flatMap((n) => (n.code ? [n.code] : []))),
  );

  try {
    const consents = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const purposeCode of purposeCodes) {
        if (purposeCode === PURPOSE_CODES.MARKETING_COMMS) {
          created.push(
            await grantMarketingConsent(tx, userId, parsed.data.language),
          );
        } else if (purposeCode === PURPOSE_CODES.ANALYTICS) {
          const saved = await saveCookiePreferences(
            tx,
            { userId },
            { analytics: true },
            parsed.data.language,
          );
          if (saved.consent) created.push(saved.consent);
        } else {
          created.push(
            await tx.consentArtifact.create({
              data: buildConsentArtifact({
                userId,
                dataFiduciary: "Familiarise",
                purposeCodes: [purposeCode],
                language: parsed.data.language,
                consentManager: null,
                version: parsed.data.version,
              }),
            }),
          );
        }
      }
      return created;
    });

    if (purposeCodes.includes(PURPOSE_CODES.MARKETING_COMMS)) {
      await attemptSubscriberSync(userId).catch((error: unknown) =>
        Sentry.captureException(error, {
          level: "warning",
          tags: { subsystem: "novu", op: "privacy-consent.sync" },
        }),
      );
    }
    return NextResponse.json({ consents }, { status: 201 });
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
    const { withdrawnCount } = await prisma.$transaction(async (tx) => {
      if (purposeCode === PURPOSE_CODES.MARKETING_COMMS)
        return withdrawMarketingConsent(tx, userId);
      if (purposeCode === PURPOSE_CODES.ANALYTICS) {
        const saved = await saveCookiePreferences(
          tx,
          { userId },
          { analytics: false },
        );
        return { withdrawnCount: saved.withdrawnCount };
      }
      const result = await withdrawConsent(
        { userId, purposeCode, dataFiduciary: "Familiarise" },
        tx,
      );
      return result;
    });

    if (purposeCode === PURPOSE_CODES.MARKETING_COMMS) {
      await attemptSubscriberSync(userId).catch((error: unknown) =>
        Sentry.captureException(error, {
          level: "warning",
          tags: { subsystem: "novu", op: "privacy-consent.sync" },
        }),
      );
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
