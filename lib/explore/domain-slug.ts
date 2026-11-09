/** "Creative Arts" -> "creative-arts". Domains have no stored slug, so the URL form is derived from the name. */
export function domainSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function domainPath(name: string): string {
  return `/explore/experts/c/${domainSlug(name)}`;
}

/** The domain whose name slugs to `slug`, or undefined. */
export function findDomainBySlug<T extends { name: string }>(
  domains: readonly T[],
  slug: string,
): T | undefined {
  return domains.find((domain) => domainSlug(domain.name) === slug);
}
