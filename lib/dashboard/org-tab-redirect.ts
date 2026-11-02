import { z } from "zod";

import { retiredRouteHref } from "./personal-legacy-routes";

export const ORG_TAB_REDIRECTS = {
  "purchase-orders": { page: "billing", tab: "purchase-orders" },
  reimbursements: { page: "billing", tab: "member-spend" },
  disputes: { page: "billing", tab: "disputes" },
  documents: { page: "library", tab: "documents" },
  recordings: { page: "library", tab: "recordings" },
} as const;

export type OrgRetiredTabRoute = keyof typeof ORG_TAB_REDIRECTS;

/** A destination tab; null opens the page's default tab. */
type OrgTab = string | null;

/**
 * Target of a retired org route that became a tab (#1527 Q7). The old URL's
 * query survives so filters and deep links keep working; `tab` always wins.
 */
export function orgTabHref(
  orgId: string,
  page: string,
  tab: OrgTab,
  searchParams: Record<string, string | string[] | undefined> = {},
): string {
  return retiredRouteHref(
    `/dashboard/organization/${orgId}/${page}`,
    tab,
    searchParams,
  );
}

export function orgRetiredRouteHref(
  orgId: string,
  route: OrgRetiredTabRoute,
  searchParams: Record<string, string | string[] | undefined> = {},
): string {
  const target = ORG_TAB_REDIRECTS[route];
  return orgTabHref(orgId, target.page, target.tab, searchParams);
}

/** Catalog's `?status=`: `archived` lists withdrawn plans instead of live ones. */
const CatalogStatusSchema = z.enum(["archived"]);

export function isArchivedCatalogView(
  status: string | string[] | null | undefined,
): boolean {
  return CatalogStatusSchema.safeParse(status).success;
}

interface TabTarget {
  page: string;
  tab: OrgTab;
  /** The stacked section inside the merged tab. */
  anchor?: string;
  query?: Record<string, string>;
}

/** Every `?tab=` each org page has answered, current values included. */
const ORG_PAGE_TAB_SCHEMAS = {
  billing: z.enum([
    "invoices",
    "accrued-usage",
    "wallet",
    "license",
    "purchase-orders",
    "disputes",
    "member-spend",
  ]),
  payouts: z.enum([
    "runs",
    "earnings",
    "payout-account",
    "rate-cards",
    "expert-routing",
  ]),
  catalog: z.enum([
    "webinars",
    "classes",
    "archived",
    "materials",
    "collaborators",
  ]),
};

export type OrgTabbedPage = keyof typeof ORG_PAGE_TAB_SCHEMAS;

/** Where each of those values opens now; an identity entry is a current tab. */
export const ORG_PAGE_TAB_MAP: {
  [P in OrgTabbedPage]: Record<
    z.infer<(typeof ORG_PAGE_TAB_SCHEMAS)[P]>,
    TabTarget
  >;
} = {
  billing: {
    invoices: { page: "billing", tab: "invoices" },
    "accrued-usage": {
      page: "billing",
      tab: "invoices",
      anchor: "accrued-usage",
    },
    wallet: { page: "billing", tab: "wallet" },
    license: { page: "billing", tab: "wallet", anchor: "license" },
    "purchase-orders": { page: "billing", tab: "purchase-orders" },
    disputes: { page: "billing", tab: "disputes" },
    "member-spend": { page: "billing", tab: "member-spend" },
  },
  payouts: {
    runs: { page: "payouts", tab: "runs" },
    earnings: { page: "payouts", tab: "runs", anchor: "earnings" },
    "payout-account": { page: "payouts", tab: "payout-account" },
    "rate-cards": { page: "payouts", tab: "rate-cards" },
    "expert-routing": {
      page: "payouts",
      tab: "rate-cards",
      anchor: "expert-routing",
    },
  },
  catalog: {
    webinars: { page: "catalog", tab: "webinars" },
    classes: { page: "catalog", tab: "classes" },
    archived: { page: "catalog", tab: null, query: { status: "archived" } },
    materials: { page: "catalog", tab: "materials" },
    collaborators: { page: "collaborators", tab: null },
  },
};

/** The new home of a retired `?tab=` on `page`, or null when the URL is current. */
export function orgLegacyTabHref(
  orgId: string,
  page: OrgTabbedPage,
  searchParams: Record<string, string | string[] | undefined>,
): string | null {
  const parsed = ORG_PAGE_TAB_SCHEMAS[page].safeParse(searchParams.tab);
  if (!parsed.success) return null;
  const targets: Readonly<Record<string, TabTarget>> = ORG_PAGE_TAB_MAP[page];
  const target = targets[parsed.data];
  if (
    target.page === page &&
    target.tab === parsed.data &&
    !target.anchor &&
    !target.query
  ) {
    return null;
  }
  const href = orgTabHref(orgId, target.page, target.tab, {
    ...searchParams,
    ...target.query,
  });
  return target.anchor ? `${href}#${target.anchor}` : href;
}
