import { SellOfferingsList } from "@/components/offerings/list/SellOfferingsList";
import { SellPageShell } from "@/components/offerings/list/SellPageShell";
import { SELL_TAB_SCHEMAS, type SessionsTab } from "@/lib/dashboard/sell-pages";

const TABS: readonly { value: SessionsTab; label: string }[] = [
  { value: "consultations", label: "Consultations" },
  { value: "subscriptions", label: "Subscriptions" },
];

export default async function SellSessionsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  const active = SELL_TAB_SCHEMAS.sessions.parse((await searchParams).tab);
  return (
    <SellPageShell
      consultantId={consultantId}
      title="1:1 & subscriptions"
      description="Sessions you sell to one client at a time"
      tabs={{ page: "sessions", options: TABS, active }}
    >
      <SellOfferingsList
        key={active}
        consultantId={consultantId}
        type={active === "consultations" ? "consultation" : "subscription"}
      />
    </SellPageShell>
  );
}
