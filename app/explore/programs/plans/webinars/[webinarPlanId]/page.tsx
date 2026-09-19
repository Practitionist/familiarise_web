import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { getWebinarPlanDetail } from "@/lib/data/plan-details";
import { WebinarDetails } from "./components/WebinarDetails";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export default async function WebinarDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ webinarPlanId: string }>;
}>) {
  const { webinarPlanId } = await params;
  // The plan read is keyed on the URL id and the session read on the cookie —
  // independent, so they run concurrently; the gate reuses the session.
  const [webinarData, session] = await Promise.all([
    getWebinarPlanDetail(webinarPlanId),
    getSession().catch((error) => {
      reportSentryError(error, { subsystem: "plans", expected: true });
      return null;
    }),
  ]);

  if (!webinarData) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(webinarData, session))) {
    notFound();
  }

  const firstWebinarInstance = webinarData.webinars?.[0];
  const nextSession =
    firstWebinarInstance?.appointment?.occurrences?.[0]?.startsAt;

  return (
    <WebinarDetails
      plan={webinarData}
      nextSession={nextSession}
      webinarId={firstWebinarInstance?.id}
    />
  );
}
