import { DigitalProductList } from "@/components/offerings/list/DigitalProductList";
import { HostedReplays } from "@/components/offerings/list/HostedReplays";
import { SellPageShell } from "@/components/offerings/list/SellPageShell";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { listHostedReplays } from "@/lib/data/recordings-explore";
import { SELL_TAB_SCHEMAS, type ProductsTab } from "@/lib/dashboard/sell-pages";

const TABS: readonly { value: ProductsTab; label: string }[] = [
  { value: "digital", label: "Digital products" },
  { value: "replays", label: "Replays" },
];

const DESCRIPTION: Record<ProductsTab, string> = {
  digital: "Files you sell once, for buyers to keep",
  replays: "Recordings of sessions you hosted, listed for sale",
};

async function ReplaysPanel({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  await requirePersonalProfileAccess("consultant", consultantId);
  const replays = await listHostedReplays(consultantId);
  return <HostedReplays consultantId={consultantId} replays={replays} />;
}

export default async function SellProductsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  const active = SELL_TAB_SCHEMAS.products.parse((await searchParams).tab);
  return (
    <SellPageShell
      consultantId={consultantId}
      title="Products"
      description={DESCRIPTION[active]}
      tabs={{ page: "products", options: TABS, active }}
    >
      {active === "replays" ? (
        <ReplaysPanel consultantId={consultantId} />
      ) : (
        <DigitalProductList consultantId={consultantId} />
      )}
    </SellPageShell>
  );
}
