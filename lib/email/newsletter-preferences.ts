import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { normaliseEmail } from "./suppression";

const NEWSLETTER_RECIPIENT_SELECT = {
  email: true,
  erasedAt: true,
  notificationPreferences: {
    select: {
      allNotifications: true,
      emailEnabled: true,
      marketingEmails: true,
    },
  },
} as const;

export interface NewsletterPreferenceReader {
  user: {
    findMany(args: {
      where: { email: { in: string[]; mode: "insensitive" } };
      select: typeof NEWSLETTER_RECIPIENT_SELECT;
    }): Promise<
      Prisma.UserGetPayload<{
        select: typeof NEWSLETTER_RECIPIENT_SELECT;
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
    select: NEWSLETTER_RECIPIENT_SELECT,
  });
  return new Set(
    users.flatMap((user) => {
      const pref = user.notificationPreferences;
      return user.email &&
        (user.erasedAt ||
          !pref?.marketingEmails ||
          !pref.allNotifications ||
          !pref.emailEnabled)
        ? [normaliseEmail(user.email)]
        : [];
    }),
  );
}
