import prisma, { type Tx } from "@/lib/prisma";
import { buildSignupConsentArtifacts } from "@/lib/compliance/dpdp";
import {
  PURPOSE_CODES,
  purposeCodeAliases,
} from "@/lib/compliance/purpose-codes";

/**
 * DPDP consent for platform operators. A consumer's signup stamps consent and
 * an SSO member is asked by their org's JoinConsentGate, but an operator
 * account is created by an admin and has no org, so neither path applies.
 * The back-office layout asks instead, once, until any core-processing
 * artifact exists (granted or withdrawn: someone who withdrew is not nagged).
 */
export async function operatorHasBeenAskedForConsent(
  userId: string,
  db: Tx | typeof prisma = prisma,
): Promise<boolean> {
  const artifact = await db.consentArtifact.findFirst({
    where: {
      userId,
      purposeCodes: {
        hasSome: purposeCodeAliases(PURPOSE_CODES.PRIMARY_PROCESSING),
      },
    },
    select: { id: true },
  });
  return artifact !== null;
}

/**
 * Record the operator's own consent for the signup purposes. Idempotent: a
 * second click, or a second tab, writes nothing.
 */
export async function recordOperatorConsent(userId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    if (await operatorHasBeenAskedForConsent(userId, tx)) return 0;
    const { count } = await tx.consentArtifact.createMany({
      data: buildSignupConsentArtifacts(userId),
    });
    return count;
  });
}
