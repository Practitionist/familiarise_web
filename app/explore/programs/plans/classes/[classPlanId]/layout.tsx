import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getClassPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing, archived or ORG_ONLY-for-outsiders plan answers 404 before any
// Suspense fallback commits a 200.
export default async function ClassPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ classPlanId: string }>;
}>) {
  const { classPlanId } = await params;
  const plan = await getClassPlanDetail(classPlanId);
  if (!plan || !(await canViewPlanDetail(plan))) notFound();

  return children;
}
