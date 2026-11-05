import prisma, { type Tx } from "@/lib/prisma";
import {
  buildConsentArtifact,
  PLATFORM_DATA_FIDUCIARY,
  withdrawConsent,
} from "./dpdp";
import { PURPOSE_CODES, TERMS_VERSION } from "./purpose-codes";
import { marketingConsentWhere } from "./marketing-policy";
import { subscriberSyncMark } from "@/lib/novu/subscriber";

type MarketingConsentDb = Tx | typeof prisma;

/** The caller commits the purpose evidence and delivery preference in one transaction. */
export async function grantMarketingConsent(
  db: MarketingConsentDb,
  userId: string,
  language = "en-IN",
) {
  const mark = subscriberSyncMark();
  await db.notificationPreference.upsert({
    where: { userId },
    create: { userId, marketingEmails: true, ...mark },
    update: { marketingEmails: true, ...mark },
  });
  const existing = await db.consentArtifact.findFirst({
    where: { userId, ...marketingConsentWhere() },
  });
  return (
    existing ??
    db.consentArtifact.create({
      data: buildConsentArtifact({
        userId,
        dataFiduciary: PLATFORM_DATA_FIDUCIARY,
        purposeCodes: [PURPOSE_CODES.MARKETING_COMMS],
        language,
        consentManager: null,
        version: TERMS_VERSION,
      }),
    })
  );
}

/** Withdrawal stops current enrollment; a later grant never resubscribes the address. */
export async function withdrawMarketingConsent(
  db: MarketingConsentDb,
  userId: string,
) {
  const mark = subscriberSyncMark();
  await db.notificationPreference.upsert({
    where: { userId },
    create: { userId, marketingEmails: false, ...mark },
    update: { marketingEmails: false, ...mark },
  });
  const result = await withdrawConsent(
    {
      userId,
      purposeCode: PURPOSE_CODES.MARKETING_COMMS,
      dataFiduciary: PLATFORM_DATA_FIDUCIARY,
    },
    db,
  );
  const account = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (account?.email)
    await db.waitlist.updateMany({
      where: {
        email: {
          equals: account.email.trim().toLowerCase(),
          mode: "insensitive",
        },
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
    });
  return result;
}
