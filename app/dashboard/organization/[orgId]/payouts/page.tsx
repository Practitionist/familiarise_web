import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { PayoutsPageClient } from "./PayoutsPageClient";

// Server wrapper: reads the server-only `ENABLE_LIVE_PAYOUTS` flag (#776 §B)
// and threads it to the client so PROCESSING payouts render as honestly
// held rather than implying money is moving. `params` is forwarded as the
// promise the client `use()`s.
export default async function OrgPayoutsPage({
  params,
}: Readonly<{
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  return (
    <PayoutsPageClient
      params={params}
      livePayoutsEnabled={ENABLE_LIVE_PAYOUTS}
    />
  );
}
