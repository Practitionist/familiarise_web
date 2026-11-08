/**
 * The newsletter follows the DPDP `MARKETING_COMMS` consent ledger: an account
 * grant subscribes the account's address, a confirmed sign-up writes an artifact
 * (for the account, or a pseudonymous subject), and every unsubscribe withdraws it.
 */

import { createHmac } from "node:crypto";
import { NewsletterStatus, type Prisma } from "@prisma/client";
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

/**
 * Row-locks the matching subscribers and returns their linkage as committed after the
 * lock, so a confirmation racing this transaction is seen, never a stale snapshot.
 * Lock order for every consent withdrawal: NewsletterSubscriber rows first, then ConsentArtifact rows.
 */
export function lockNewsletterRows(
  tx: Pick<Tx, "newsletterSubscriber">,
  where: Prisma.NewsletterSubscriberWhereInput,
  now: Date,
) {
  return tx.newsletterSubscriber.updateManyAndReturn({
    where,
    data: { updatedAt: now },
    select: { email: true, userId: true, consentSubjectId: true },
  });
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

/**
 * Unsubscribes the account's rows, by link or by address, and withdraws the address's
 * pseudonymous newsletter consent in the withdrawal's transaction.
 */
export async function unsubscribeForWithdrawnConsent(
  tx: Pick<Tx, "newsletterSubscriber" | "consentArtifact">,
  input: { userId: string; email: string; now: Date },
): Promise<number> {
  const where = {
    OR: [
      { userId: input.userId },
      { email: normalizeNewsletterEmail(input.email) },
    ],
  };
  const rows = await lockNewsletterRows(tx, where, input.now);
  const { count } = await tx.newsletterSubscriber.updateMany({
    where: {
      ...where,
      status: { in: [NewsletterStatus.PENDING, NewsletterStatus.SUBSCRIBED] },
    },
    data: { status: NewsletterStatus.UNSUBSCRIBED, unsubscribedAt: input.now },
  });
  await withdrawNewsletterSubjects(tx, {
    email: input.email,
    subjectIds: rows.map((row) => row.consentSubjectId),
    now: input.now,
  });
  return count;
}

/**
 * Records `MARKETING_COMMS` consent for a confirmed sign-up, on the account when
 * one is linked and on the address's pseudonymous subject otherwise; a live grant is reused.
 */
export async function recordNewsletterConsent(
  tx: Tx,
  input: {
    email: string;
    userId: string | null;
    subjectId: string;
    now: Date;
  },
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
  const subjectPseudonymousId = input.subjectId;
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

/**
 * Withdraws the pseudonymous `MARKETING_COMMS` consent of each stored subject id,
 * recomputing it from the address only when no row stored one.
 */
export async function withdrawNewsletterSubjects(
  tx: Pick<Tx, "consentArtifact">,
  input: { email: string; subjectIds: (string | null)[]; now: Date },
): Promise<number> {
  const stored = [
    ...new Set(input.subjectIds.filter((id): id is string => !!id)),
  ];
  const subjects =
    stored.length > 0 ? stored : [newsletterSubjectId(input.email)];
  let withdrawn = 0;
  for (const subjectPseudonymousId of subjects) {
    const { withdrawnCount } = await withdrawPseudonymousConsent(
      {
        subjectPseudonymousId,
        purposeCode: PURPOSE_CODES.MARKETING_COMMS,
        now: input.now,
      },
      tx,
    );
    withdrawn += withdrawnCount;
  }
  return withdrawn;
}

/** Withdraws the address's `MARKETING_COMMS` consent: the linked account's and its pseudonymous subject's. */
export async function withdrawNewsletterConsent(
  tx: Tx,
  input: {
    email: string;
    userId: string | null;
    subjectId: string | null;
    now: Date;
  },
): Promise<void> {
  if (input.userId) {
    await withdrawConsent(
      {
        userId: input.userId,
        purposeCode: PURPOSE_CODES.MARKETING_COMMS,
        now: input.now,
      },
      tx,
    );
  }
  await withdrawNewsletterSubjects(tx, {
    email: input.email,
    subjectIds: [input.subjectId],
    now: input.now,
  });
}
