import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getWebinarPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function WebinarPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ webinarPlanId: string }>;
}>) {
  const { webinarPlanId } = await params;
  if (!(await getWebinarPlanDetail(webinarPlanId))) notFound();

  return children;
}
