import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getClassPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function ClassPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ classPlanId: string }>;
}>) {
  const { classPlanId } = await params;
  if (!(await getClassPlanDetail(classPlanId))) notFound();

  return children;
}
