import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import type { Metadata } from "next";
import { getSubscriptionPlanDetail } from "@/lib/data/plan-details";
import { SubscriptionDetails } from "./components/SubscriptionDetails";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: Readonly<{
  params: Promise<{ subscriptionPlanId: string }>;
}>): Promise<Metadata> {
  const { subscriptionPlanId } = await params;
  const plan = await getSubscriptionPlanDetail(subscriptionPlanId).catch(
    () => null,
  );
  if (!plan) return { title: "Programme not found" };
  const mentor = plan.consultantProfile?.user?.name;
  return {
    title: `${plan.title}${mentor ? ` with ${mentor}` : ""} — Familiarise`,
    description:
      plan.subtitle ??
      plan.description?.slice(0, 155) ??
      `${plan.durationInMonths}-month mentorship programme on Familiarise.`,
  };
}

export default async function SubscriptionDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ subscriptionPlanId: string }>;
}>) {
  const { subscriptionPlanId } = await params;
  // The plan read is keyed on the URL id and the session read on the cookie —
  // independent, so they run concurrently; the gate reuses the session.
  const [plan, session] = await Promise.all([
    getSubscriptionPlanDetail(subscriptionPlanId),
    getSession().catch((error) => {
      reportSentryError(error, { subsystem: "plans", expected: true });
      return null;
    }),
  ]);

  if (!plan) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(plan, session))) {
    notFound();
  }

  return <SubscriptionDetails plan={plan} />;
}
