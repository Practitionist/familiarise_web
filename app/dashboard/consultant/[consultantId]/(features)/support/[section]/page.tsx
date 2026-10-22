import { HelpSectionPage } from "@/app/support/_components/HelpSectionPage";
export default async function HelpPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string; section: string }> }>) {
  const { consultantId, section } = await params;
  return (
    <HelpSectionPage
      section={section}
      basePath={`/dashboard/consultant/${consultantId}`}
    />
  );
}
