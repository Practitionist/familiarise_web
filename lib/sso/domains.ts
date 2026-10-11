/** Lowercased domain part of an email, or undefined when there is none. */
export function emailDomain(
  email: string | null | undefined,
): string | undefined {
  return email?.toLowerCase().split("@")[1] || undefined;
}

/**
 * The email domains a provider covers. `SsoProvider.domain` is a comma-separated
 * list, the same shape the sso() plugin parses for multi-domain providers.
 */
export function providerDomains(domain: string): string[] {
  return [
    ...new Set(
      domain
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Canonical stored form: lowercased, de-duplicated and sorted. */
export function serializeProviderDomains(domains: readonly string[]): string {
  // Code-unit order, so the stored string matches rows written before.
  return providerDomains(domains.join(","))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(",");
}
