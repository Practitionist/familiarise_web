import { SellOfferingsList } from "@/components/offerings/list/SellOfferingsList";
import { SellPageShell } from "@/components/offerings/list/SellPageShell";
import { SELL_TAB_SCHEMAS, type ProgramsTab } from "@/lib/dashboard/sell-pages";

const TABS: readonly { value: ProgramsTab; label: string }[] = [
  { value: "webinars", label: "Webinars" },
  { value: "classes", label: "Classes" },
];

export default async function SellProgramsPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  const active = SELL_TAB_SCHEMAS.programs.parse((await searchParams).tab);
  return (
    <SellPageShell
      consultantId={consultantId}
      title="Group programs"
      description="Webinars and classes you run for many attendees"
      tabs={{ page: "programs", options: TABS, active }}
    >
      <SellOfferingsList
        key={active}
        consultantId={consultantId}
        type={active === "webinars" ? "webinar" : "class"}
      />
    </SellPageShell>
  );
}
