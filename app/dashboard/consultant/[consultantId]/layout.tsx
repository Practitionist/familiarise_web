import { notFound } from "next/navigation";

import { requireOnboarded } from "@/lib/auth-guard";
import { viewerMayOpenProfile } from "@/lib/dashboard/profile-access";
import ConsultantDashboardLayout from "./ConsultantDashboardLayout";

/** A missing or not-owned profile id 404s here, above this segment's loading.tsx, so the status is real. */
export default async function ConsultantLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}>) {
  const { consultantId } = await params;
  const { user } = await requireOnboarded();
  if (!(await viewerMayOpenProfile("consultant", consultantId, user)))
    notFound();
  return (
    <ConsultantDashboardLayout params={params}>
      {children}
    </ConsultantDashboardLayout>
  );
}
