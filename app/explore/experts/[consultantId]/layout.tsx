import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getConsultantDetail } from "@/lib/data/consultant-detail";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function ExpertLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ consultantId: string }>;
}>) {
  const { consultantId } = await params;
  const consultant = await getConsultantDetail(consultantId);
  if (!consultant?.user) notFound();

  return children;
}
