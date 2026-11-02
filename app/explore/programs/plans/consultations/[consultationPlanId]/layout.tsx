import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getConsultationPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function ConsultationPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ consultationPlanId: string }>;
}>) {
  const { consultationPlanId } = await params;
  if (!(await getConsultationPlanDetail(consultationPlanId))) notFound();

  return children;
}
