import type { Prisma } from "@prisma/client";
import type { Db, Tx } from "@/lib/prisma";
import { ensureConsentPurposes } from "@/lib/compliance/dpdp";
import {
  PURPOSE_CODES,
  SIGNUP_PURPOSES,
  type PurposeCode,
} from "@/lib/compliance/purpose-codes";
import {
  subscribeForMarketingConsent,
  type ConsentProvenance,
} from "@/lib/newsletter/consent-link";
import type { OnboardingConsent } from "./onboarding";

/**
 * The one terminal onboarding transition, shared by the wizard, the gate and
 * org creation. CAS on `onboardingCompleted`, so it must be the first write in
 * its transaction: it takes the user-row lock and serialises racing submits.
 * Returns false when another request already completed onboarding.
 */
export async function claimOnboardingCompletion(
  tx: Tx,
  userId: string,
  data: Prisma.UserUncheckedUpdateManyInput,
  consent: Pick<OnboardingConsent, "adultConfirmed">,
): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.user.updateMany({
    // The column is nullable, so `false` alone would skip null rows.
    where: { id: userId, onboardingCompleted: { not: true } },
    data: {
      ...data,
      onboardingCompleted: true,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      adultConfirmedAt: consent.adultConfirmed ? now : null,
    },
  });
  return count > 0;
}

/**
 * Sign-up purposes, plus marketing when ticked, each recorded at most once.
 * Marketing consent also subscribes the account's address to the newsletter.
 */
export async function recordOnboardingConsent(
  tx: Tx,
  userId: string,
  consent: Pick<OnboardingConsent, "marketingConsent">,
  provenance: ConsentProvenance,
): Promise<void> {
  const purposes: PurposeCode[] = [...SIGNUP_PURPOSES];
  if (consent.marketingConsent) purposes.push(PURPOSE_CODES.MARKETING_COMMS);
  await ensureConsentPurposes(tx, userId, purposes);
  if (!consent.marketingConsent) return;
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  await subscribeForMarketingConsent(tx, {
    userId,
    email: user.email,
    now: new Date(),
    provenance,
  });
}

/** An org member (invite or SSO JIT) is onboarded by the gate, not the B2C wizard. */
export async function hasActiveMembership(
  db: Db | Tx,
  userId: string,
): Promise<boolean> {
  const membership = await db.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * Who may complete onboarding through the gate: an org member, or the holder
 * of a pending, unexpired invitation addressed to their verified email.
 */
export async function canUseOnboardingGate(
  db: Db | Tx,
  user: { id: string; email: string; emailVerified: boolean },
): Promise<boolean> {
  if (await hasActiveMembership(db, user.id)) return true;
  if (!user.emailVerified) return false;
  const invitation = await db.invitation.findFirst({
    where: {
      email: { equals: user.email, mode: "insensitive" },
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return invitation !== null;
}
