import { permanentRedirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import { accountSettingsHref } from "@/lib/dashboard/account-href";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/profile` is retired (#1527 §17b): the account lives in each viewer's own
 * Settings. This answers a 308 to it — consultant or consultee Settings ›
 * Account, the back office's My profile, a workspace's settings — keeping any
 * query (an OAuth link result, say) and honouring `?section=notifications`.
 * requireAuth sends a signed-out visitor to sign-in first.
 */
export default async function ProfileRedirect({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const { user } = await requireAuth();
  const sp = await searchParams;
  const section = sp.section === "notifications" ? "notifications" : "account";
  const target = accountSettingsHref(user, section) ?? "/dashboard";

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "section" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value])
      query.append(key, v);
  }
  const qs = query.toString();
  permanentRedirect(qs ? `${target}?${qs}` : target);
}
