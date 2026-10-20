import { HelpSupportLayout } from "@/components/dashboard/shared/support/HelpSupportLayout";
export default async function HelpLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgWorkspaceId: string }>;
}>) {
  const { orgWorkspaceId } = await params;
  return (
    <HelpSupportLayout basePath={`/dashboard/org-workspace/${orgWorkspaceId}`}>
      {children}
    </HelpSupportLayout>
  );
}
