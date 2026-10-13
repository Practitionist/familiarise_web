export const ORG_TAB_REDIRECTS = {
  "purchase-orders": { page: "billing", tab: "purchase-orders" },
  reimbursements: { page: "billing", tab: "member-spend" },
  disputes: { page: "billing", tab: "disputes" },
} as const;

export type OrgRetiredTabRoute = keyof typeof ORG_TAB_REDIRECTS;

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

export function orgRetiredRouteHref(
  orgId: string,
  route: OrgRetiredTabRoute,
  searchParams: Record<string, string | string[] | undefined> = {},
): string {
  const target = ORG_TAB_REDIRECTS[route];
  return orgTabHref(orgId, target.page, target.tab, searchParams);
}
