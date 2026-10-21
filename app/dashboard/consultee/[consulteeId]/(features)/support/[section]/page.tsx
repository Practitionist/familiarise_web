import { HelpSectionPage } from "@/app/support/_components/HelpSectionPage";
export default async function HelpPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string; section: string }> }>) {
  const { consulteeId, section } = await params;
  return (
    <HelpSectionPage
      section={section}
      basePath={`/dashboard/consultee/${consulteeId}`}
    />
  );
}
