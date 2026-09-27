/**
 * Target of a retired org route that became a tab (#1527 Q7). The old URL's
 * query survives so filters and deep links keep working; `tab` always wins.
 */
export function orgTabHref(
  orgId: string,
  page: string,
  tab: string,
  searchParams: Record<string, string | string[] | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      params.append(key, v);
    }
  }
  params.set("tab", tab);
  return `/dashboard/organization/${orgId}/${page}?${params.toString()}`;
}
