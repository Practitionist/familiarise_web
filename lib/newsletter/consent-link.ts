/**
 * The newsletter (`Waitlist`) follows the account's DPDP `MARKETING_COMMS`
 * consent: a grant subscribes the account's address, a withdrawal unsubscribes
 * it, and the newsletter's own unsubscribe withdraws the linked consent.
 */

import { createHash } from "node:crypto";
import { NewsletterStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { stampedClientIp } from "@/lib/request-ip";

/** Salted with the HMAC secret so the digest is not reversible from the v4 space. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256")
    .update(`${process.env.WAITLIST_HMAC_SECRET ?? "waitlist"}|${ip}`)
    .digest("hex");
}

export function normalizeNewsletterEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Marks a row first created by an account's consent grant rather than a public sign-up form. */
export const ACCOUNT_CONSENT_TAG = "account-consent";

type NewsletterTx = Pick<Tx, "newsletterSubscriber">;

/** The request a consent grant came from; the IP is the middleware-stamped one. */
export interface ConsentProvenance {
  ip: string | null;
  userAgent: string | null;
}

export function consentProvenance(headers: {
  get(name: string): string | null;
}): ConsentProvenance {
  return {
    ip: stampedClientIp(headers),
    userAgent: headers.get("user-agent"),
  };
}

/**
 * Subscribes the account's address in the grant's transaction. The consent
 * artifact is the evidence, so no double-opt-in email is sent.
 */
export async function subscribeForMarketingConsent(
  tx: NewsletterTx,
  input: {
    userId: string;
    email: string;
    now: Date;
    provenance: ConsentProvenance;
  },
): Promise<void> {
  const email = normalizeNewsletterEmail(input.email);
  const fields = {
    userId: input.userId,
    status: NewsletterStatus.SUBSCRIBED,
    confirmedAt: input.now,
    unsubscribedAt: null,
    consentIpHash: hashIp(input.provenance.ip),
    consentUserAgent: input.provenance.userAgent?.slice(0, 500) ?? null,
  };
  await tx.newsletterSubscriber.upsert({
    where: { email },
    create: { email, tags: [ACCOUNT_CONSENT_TAG], ...fields },
    update: fields,
  });
}

/** Unsubscribes the account's rows, by link or by address, in the withdrawal's transaction. */
export async function unsubscribeForWithdrawnConsent(
  tx: NewsletterTx,
  input: { userId: string; email: string; now: Date },
): Promise<number> {
  const { count } = await tx.newsletterSubscriber.updateMany({
    where: {
      OR: [
        { userId: input.userId },
        { email: normalizeNewsletterEmail(input.email) },
      ],
      status: { in: [NewsletterStatus.PENDING, NewsletterStatus.SUBSCRIBED] },
    },
    data: { status: NewsletterStatus.UNSUBSCRIBED, unsubscribedAt: input.now },
  });
  return count;
}
