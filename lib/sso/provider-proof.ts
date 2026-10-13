import prisma, { type PrismaLike } from "@/lib/prisma";

/**
 * Marks a provider proven on the first successful SSO login by an ACTIVE OWNER
 * of its org. Turning enforcement on requires a proven provider.
 */
export async function stampProviderProven(input: {
  providerId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const owner = await prisma.membership.findFirst({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!owner) return false;
  const { count } = await prisma.ssoProvider.updateMany({
    where: {
      providerId: input.providerId,
      organizationId: input.organizationId,
      domainVerified: true,
      provenAt: null,
    },
    data: { provenAt: new Date(), provenByUserId: input.userId },
  });
  return count > 0;
}

export const SSO_NOT_PROVEN_MESSAGE =
  "Sign in once through an approved SSO provider as an organization owner before enforcing SSO, so a misconfigured provider cannot lock everyone out.";

/** Approved providers of the org that an OWNER has signed in through. */
export function countProvenProviders(
  db: PrismaLike,
  organizationId: string,
): Promise<number> {
  return db.ssoProvider.count({
    where: { organizationId, domainVerified: true, provenAt: { not: null } },
  });
}
