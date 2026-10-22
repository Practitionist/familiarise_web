import { notFound } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { HelpSupportLayout } from "@/components/dashboard/shared/support/HelpSupportLayout";

export default async function HelpLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    allowSuspended: true,
  });
  if (access.error) notFound();
  return (
    <HelpSupportLayout
      basePath={`/dashboard/organization/${orgId}`}
      organization
      canTriage={
        access.member.status === "ACTIVE" &&
        hasOrgPermission(access.member.role, "operations.read")
      }
    >
      {children}
    </HelpSupportLayout>
  );
}
