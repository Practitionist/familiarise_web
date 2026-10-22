import { HelpSectionPage } from "@/app/support/_components/HelpSectionPage";
export default async function HelpPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string; section: string }> }>) {
  const { orgWorkspaceId, section } = await params;
  return (
    <HelpSectionPage
      section={section}
      basePath={`/dashboard/org-workspace/${orgWorkspaceId}`}
    />
  );
}
