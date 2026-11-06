import type { ConsentArtifact } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import type {
  CookiePreferences,
  CookiePreferenceUpdate,
} from "@/schemas/cookie-preferences";
import {
  buildConsentArtifact,
  PLATFORM_DATA_FIDUCIARY,
  withdrawConsent,
} from "./dpdp";
import {
  PURPOSE_CODES,
  TERMS_VERSION,
  purposeCodeAliases,
} from "./purpose-codes";

type CookieDb = Tx;
export type CookieIdentity =
  { userId: string; sessionId?: never } | { sessionId: string; userId?: never };
function analyticsConsentWhere(userId: string) {
  return {
    userId,
    dataFiduciary: PLATFORM_DATA_FIDUCIARY,
    purposeCodes: { hasSome: purposeCodeAliases(PURPOSE_CODES.ANALYTICS) },
    version: TERMS_VERSION,
    withdrawnAt: null,
    auditRetainedUntil: { gt: new Date() },
  };
}

export async function readCookiePreferences(
  db: CookieDb,
  identity: CookieIdentity,
): Promise<CookiePreferences> {
  const pref = await db.cookiePreference.findUnique({
    where: identity.userId
      ? { userId: identity.userId }
      : { sessionId: identity.sessionId },
    select: { analytics: true, marketing: true },
  });
  const analytics = Boolean(
    pref?.analytics &&
    (!identity.userId ||
      (await db.consentArtifact.findFirst({
        where: analyticsConsentWhere(identity.userId),
        select: { id: true },
      }))),
  );
  return { essential: true, analytics, marketing: pref?.marketing ?? false };
}

/** Cookie choices and the authenticated analytics-purpose evidence commit together. */
export async function saveCookiePreferences(
  db: CookieDb,
  identity: CookieIdentity,
  updates: CookiePreferenceUpdate,
  language = "en-IN",
) {
  await db.cookiePreference.upsert({
    where: identity.userId
      ? { userId: identity.userId }
      : { sessionId: identity.sessionId },
    create: { ...identity, ...updates, essential: true },
    update: { ...updates, essential: true },
  });
  let consent: ConsentArtifact | null | undefined;
  let withdrawnCount = 0;
  if (identity.userId && updates.analytics === true) {
    consent = await db.consentArtifact.findFirst({
      where: analyticsConsentWhere(identity.userId),
    });
    consent ??= await db.consentArtifact.create({
      data: buildConsentArtifact({
        userId: identity.userId,
        dataFiduciary: PLATFORM_DATA_FIDUCIARY,
        purposeCodes: [PURPOSE_CODES.ANALYTICS],
        language,
        consentManager: null,
        version: TERMS_VERSION,
      }),
    });
  } else if (identity.userId && updates.analytics === false) {
    ({ withdrawnCount } = await withdrawConsent(
      {
        userId: identity.userId,
        purposeCode: PURPOSE_CODES.ANALYTICS,
        dataFiduciary: PLATFORM_DATA_FIDUCIARY,
      },
      db,
    ));
  }
  return {
    preferences: await readCookiePreferences(db, identity),
    consent,
    withdrawnCount,
  };
}
