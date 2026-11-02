import {
  accountSettingsHref,
  type AccountHrefUser,
} from "@/lib/dashboard/account-href";
import { goHref, goLibraryHref } from "@/lib/dashboard/go";
import type { DashboardFacetsResponse } from "@/lib/navigation/dashboard-facets-schema";

export interface AccountMenuLink {
  key: string;
  label: string;
  href: string;
}

export type RemoteFacets =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; facets: DashboardFacetsResponse["facets"] };

const FACET_LABEL: Record<string, string> = {
  expert: "Expert dashboard",
  client: "Learner dashboard",
  workspace: "All organizations",
  admin: "Admin",
  staff: "Staff",
};

/**
 * The dashboards to offer. Until the switcher's facets arrive (or if they
 * cannot be fetched) it is one door per personal profile the session holds,
 * with a generic Dashboard door when it holds neither.
 */
export function accountFacetLinks(
  user: AccountHrefUser,
  remote: RemoteFacets,
): { links: AccountMenuLink[]; loading: boolean } {
  if (remote.status === "ready") {
    return {
      loading: false,
      links: remote.facets.map((f) => ({
        key: f.key,
        label: FACET_LABEL[f.kind] ?? f.label,
        href: f.href,
      })),
    };
  }
  const links: AccountMenuLink[] = [];
  if (user.consultantProfileId) {
    links.push({
      key: "expert",
      label: FACET_LABEL.expert,
      href: goHref("expert"),
    });
  }
  if (user.consulteeProfileId) {
    links.push({
      key: "client",
      label: FACET_LABEL.client,
      href: goHref("client"),
    });
  }
  if (remote.status === "error") {
    links.push({ key: "all", label: "All dashboards", href: "/dashboard" });
  } else if (links.length === 0) {
    links.push({ key: "dashboard", label: "Dashboard", href: "/dashboard" });
  }
  return { links, loading: remote.status === "loading" };
}

/** My library and Settings, always present. Sign out is rendered by the caller. */
export function accountBaseLinks(user: AccountHrefUser): AccountMenuLink[] {
  return [
    { key: "library", label: "My library", href: goLibraryHref() },
    {
      key: "settings",
      label: "Settings",
      href: accountSettingsHref(user) ?? "/profile",
    },
  ];
}
