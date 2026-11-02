import {
  accountSettingsHref,
  type AccountHrefUser,
} from "@/lib/dashboard/account-href";
import { goHref, goLibraryHref } from "@/lib/dashboard/go";

export interface AccountMenuLink {
  key: "expert" | "client" | "dashboard" | "library" | "settings";
  label: string;
  href: string;
}

/**
 * The public header's account menu: one door per profile the viewer holds
 * (Dashboard when they hold neither), then My library and Settings.
 * Sign out is rendered by the caller.
 */
export function accountMenuLinks(user: AccountHrefUser): AccountMenuLink[] {
  const facets: AccountMenuLink[] = [];
  if (user.consultantProfileId) {
    facets.push({
      key: "expert",
      label: "Expert dashboard",
      href: goHref("expert"),
    });
  }
  if (user.consulteeProfileId) {
    facets.push({
      key: "client",
      label: "Learner dashboard",
      href: goHref("client"),
    });
  }
  if (facets.length === 0) {
    facets.push({ key: "dashboard", label: "Dashboard", href: "/dashboard" });
  }
  return [
    ...facets,
    { key: "library", label: "My library", href: goLibraryHref() },
    {
      key: "settings",
      label: "Settings",
      href: accountSettingsHref(user) ?? "/profile",
    },
  ];
}
