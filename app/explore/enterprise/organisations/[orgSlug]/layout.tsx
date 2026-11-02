import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { fetchOrgBySlug } from "./org-reader";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function OrganisationLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}>) {
  const { orgSlug } = await params;
  if (!(await fetchOrgBySlug(orgSlug))) notFound();

  return children;
}
