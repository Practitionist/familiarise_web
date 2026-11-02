import { permanentRedirect } from "next/navigation";

import { orgLegacyTabHref } from "@/lib/dashboard/org-tab-redirect";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { PayoutsPageClient } from "./PayoutsPageClient";

// Server wrapper: reads the server-only `ENABLE_LIVE_PAYOUTS` flag (#776 §B)
// and threads it to the client so PROCESSING payouts render as honestly
// held rather than implying money is moving. `params` is forwarded as the
// promise the client `use()`s.
export default async function OrgPayoutsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  const legacy = orgLegacyTabHref(orgId, "payouts", await searchParams);
  if (legacy) permanentRedirect(legacy);
  return (
    <PayoutsPageClient
      params={params}
      livePayoutsEnabled={ENABLE_LIVE_PAYOUTS}
    />
  );
}
