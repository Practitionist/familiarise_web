import { revalidateTag, unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";

const TAXONOMY_TAG = "taxonomy";

// Reference lists change only when a Domain/Tag/SubDomain row is written, which calls
// purgeTaxonomy(); the interval is a backstop. Rows are id/name only, so no Date crosses the cache.

export const getDomainsWithChildren = unstable_cache(
  () =>
    prisma.domain.findMany({
      relationLoadStrategy: "join",
      select: {
        id: true,
        name: true,
        subDomains: { select: { id: true, name: true, domainId: true } },
        tags: { select: { id: true, name: true, domainId: true } },
      },
    }),
  ["taxonomy-domains"],
  { revalidate: 3600, tags: [TAXONOMY_TAG] },
);

const getAllTags = unstable_cache(
  () =>
    prisma.tag.findMany({
      relationLoadStrategy: "join",
      select: {
        id: true,
        name: true,
        domainId: true,
        domain: { select: { id: true, name: true } },
      },
      orderBy: { name: "asc" },
    }),
  ["taxonomy-tags"],
  { revalidate: 3600, tags: [TAXONOMY_TAG] },
);

const getAllSubDomains = unstable_cache(
  () =>
    prisma.subDomain.findMany({
      relationLoadStrategy: "join",
      select: {
        id: true,
        name: true,
        domainId: true,
        domain: { select: { id: true, name: true } },
      },
    }),
  ["taxonomy-subdomains"],
  { revalidate: 3600, tags: [TAXONOMY_TAG] },
);

/** Tags with their parent domain, name-ordered, optionally narrowed to one domain. */
export async function getTags(domainId?: string) {
  const tags = await getAllTags();
  return domainId ? tags.filter((t) => t.domainId === domainId) : tags;
}

/** Sub-domains with their parent domain, optionally narrowed to one domain. */
export async function getSubDomains(domainId?: string) {
  const subDomains = await getAllSubDomains();
  return domainId
    ? subDomains.filter((s) => s.domainId === domainId)
    : subDomains;
}

/** Call after any Domain, SubDomain or Tag write commits. */
export function purgeTaxonomy(): void {
  revalidateTag(TAXONOMY_TAG);
}
