import { notFound } from "next/navigation";

import { requireOnboarded } from "@/lib/auth-guard";
import { viewerMayOpenProfile } from "@/lib/dashboard/profile-access";
import ConsulteeDashboardLayout from "./ConsulteeDashboardLayout";
import { ViewerZone } from "@/app/support/_components/ViewerZone";

/** A missing or not-owned profile id 404s here, above this segment's loading.tsx, so the status is real. */
export default async function ConsulteeLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}>) {
  const { consulteeId } = await params;
  const { user } = await requireOnboarded();
  if (!(await viewerMayOpenProfile("consultee", consulteeId, user))) notFound();
  return (
    <ViewerZone>
      <ConsulteeDashboardLayout params={params}>
        {children}
      </ConsulteeDashboardLayout>
    </ViewerZone>
  );
}
