/**
 * The newsletter follows the DPDP `MARKETING_COMMS` consent ledger: an account
 * grant subscribes the account's address, a confirmed sign-up writes an artifact
 * (for the account, or a pseudonymous subject), and every unsubscribe withdraws it.
 */

import { createHmac } from "node:crypto";
import { NewsletterStatus } from "@prisma/client";
import { deriveAuthKey } from "@/lib/auth/link-signing";
import {
  buildConsentArtifact,
  buildPseudonymousConsentArtifact,
  checkConsent,
  PLATFORM_DATA_FIDUCIARY,
  withdrawConsent,
  withdrawPseudonymousConsent,
} from "@/lib/compliance/dpdp";
import {
  purposeCodeAliases,
  PURPOSE_CODES,
} from "@/lib/compliance/purpose-codes";
import type { Tx } from "@/lib/prisma";
import { stampedClientIp } from "@/lib/request-ip";
import { NEWSLETTER_NOTICE_VERSION } from "./notice";

/** Keyed under its own label so the digest is not reversible from the v4 space; null without a key. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const key = deriveAuthKey("familiarise/consent-ip-salt/v1");
  if (!key) return null;
  return createHmac("sha256", key).update(ip).digest("hex");
}

/** The consent subject for an address with no account; never stores the address itself. */
export function newsletterSubjectId(email: string): string {
  const key = deriveAuthKey("familiarise/newsletter-subject/v1");
  if (!key) throw new Error("BETTER_AUTH_SECRET is not set");
  return createHmac("sha256", key)
    .update(normalizeNewsletterEmail(email))
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

/**
 * Records `MARKETING_COMMS` consent for a confirmed sign-up, on the account when
 * one is linked and on the address's pseudonymous subject otherwise; a live grant is reused.
 */
export async function recordNewsletterConsent(
  tx: Tx,
  input: { email: string; userId: string | null; now: Date },
): Promise<void> {
  const grant = {
    dataFiduciary: PLATFORM_DATA_FIDUCIARY,
    purposeCodes: [PURPOSE_CODES.MARKETING_COMMS],
    language: "en-IN",
    consentManager: null,
    version: NEWSLETTER_NOTICE_VERSION,
    grantedAt: input.now,
  };
  if (input.userId) {
    const purposeCode = PURPOSE_CODES.MARKETING_COMMS;
    if (await checkConsent({ userId: input.userId, purposeCode }, tx)) return;
    await tx.consentArtifact.create({
      data: buildConsentArtifact({ userId: input.userId, ...grant }),
    });
    return;
  }
  const subjectPseudonymousId = newsletterSubjectId(input.email);
  const live = await tx.consentArtifact.findFirst({
    where: {
      subjectPseudonymousId,
      purposeCodes: {
        hasSome: purposeCodeAliases(PURPOSE_CODES.MARKETING_COMMS),
      },
      withdrawnAt: null,
      auditRetainedUntil: { gt: input.now },
    },
    select: { id: true },
  });
  if (live) return;
  await tx.consentArtifact.create({
    data: buildPseudonymousConsentArtifact({ subjectPseudonymousId, ...grant }),
  });
}

/** Withdraws the address's `MARKETING_COMMS` consent: the linked account's and its pseudonymous subject's. */
export async function withdrawNewsletterConsent(
  tx: Tx,
  input: { email: string; userId: string | null; now: Date },
): Promise<void> {
  const purposeCode = PURPOSE_CODES.MARKETING_COMMS;
  if (input.userId) {
    await withdrawConsent(
      { userId: input.userId, purposeCode, now: input.now },
      tx,
    );
  }
  await withdrawPseudonymousConsent(
    {
      subjectPseudonymousId: newsletterSubjectId(input.email),
      purposeCode,
      now: input.now,
    },
    tx,
  );
}
