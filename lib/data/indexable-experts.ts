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
