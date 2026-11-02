import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getSubscriptionPlanDetail } from "@/lib/data/plan-details";

// Runs above this segment's loading.tsx, so a missing item answers 404 before any
// Suspense fallback commits a 200.
export default async function SubscriptionPlanLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ subscriptionPlanId: string }>;
}>) {
  const { subscriptionPlanId } = await params;
  if (!(await getSubscriptionPlanDetail(subscriptionPlanId))) notFound();

  return children;
}
