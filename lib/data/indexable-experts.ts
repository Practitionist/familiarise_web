import prisma from "@/lib/prisma";

/** One sitemap file holds 50,000 URLs; the static routes and plan pages use far fewer. */
const MAX_EXPERTS = 5_000;

/** Verified, not erased: the same gate the public profile page applies. */
export async function listIndexableExpertIds(): Promise<string[]> {
  const rows = await prisma.consultantProfile.findMany({
    where: { verificationStatus: "VERIFIED", deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPERTS,
  });
  return rows.map((row) => row.id);
}

/** Every field that has at least one verified expert, for its category page. */
export async function listIndexableDomainNames(): Promise<string[]> {
  const rows = await prisma.domain.findMany({
    where: {
      consultantProfiles: {
        some: { verificationStatus: "VERIFIED", deletedAt: null },
      },
    },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => row.name);
}
