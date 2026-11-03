import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getPublicRecordingBySlug } from "@/lib/data/recordings-explore";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function RecordingLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ slug: string }>;
}>) {
  const { slug } = await params;
  if (!(await getPublicRecordingBySlug(slug))) notFound();

  return children;
}
