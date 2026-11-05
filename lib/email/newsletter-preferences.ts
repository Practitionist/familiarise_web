import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { marketingConsentWhere } from "@/lib/compliance/marketing-policy";
import { normaliseEmail } from "./suppression";

const newsletterRecipientSelect = () =>
  ({
    email: true,
    erasedAt: true,
    consentArtifacts: {
      where: marketingConsentWhere(),
      take: 1,
      select: { id: true },
    },
    notificationPreferences: {
      select: {
        allNotifications: true,
        emailEnabled: true,
        marketingEmails: true,
      },
    },
  }) as const;

export interface NewsletterPreferenceReader {
  user: {
    findMany(args: {
      where: { email: { in: string[]; mode: "insensitive" } };
      select: ReturnType<typeof newsletterRecipientSelect>;
    }): Promise<
      Prisma.UserGetPayload<{
        select: ReturnType<typeof newsletterRecipientSelect>;
      }>[]
    >;
  };
}

/** Account switches can veto a confirmed newsletter subscription, never create one. */
export async function findNewsletterPreferenceBlocks(
  emails: string[],
  db: NewsletterPreferenceReader = prisma,
): Promise<Set<string>> {
  const addresses = [...new Set(emails.map(normaliseEmail))].filter(Boolean);
  if (addresses.length === 0) return new Set();
  const users = await db.user.findMany({
    where: { email: { in: addresses, mode: "insensitive" } },
    select: newsletterRecipientSelect(),
  });
  return new Set(
    users.flatMap((user) => {
      const pref = user.notificationPreferences;
      return user.email &&
        (user.erasedAt ||
          !pref?.marketingEmails ||
          !pref.allNotifications ||
          !pref.emailEnabled ||
          user.consentArtifacts.length === 0)
        ? [normaliseEmail(user.email)]
        : [];
    }),
  );
}
