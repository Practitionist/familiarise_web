import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth-server";
import { getDigitalProductForViewer } from "@/lib/data/digital-products-public";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function ProductLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ slug: string }>;
}>) {
  const { slug } = await params;
  const session = await getSession();
  const product = await getDigitalProductForViewer(
    slug,
    session?.user?.id ?? null,
  );
  if (!product) notFound();

  return children;
}
