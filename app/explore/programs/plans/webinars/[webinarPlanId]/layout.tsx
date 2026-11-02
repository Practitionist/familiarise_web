import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getWebinarPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing, archived or ORG_ONLY-for-outsiders plan answers 404 before any
// Suspense fallback commits a 200.
export default async function WebinarPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ webinarPlanId: string }>;
}>) {
  const { webinarPlanId } = await params;
  const plan = await getWebinarPlanDetail(webinarPlanId);
  if (!plan || !(await canViewPlanDetail(plan))) notFound();

  return children;
}
