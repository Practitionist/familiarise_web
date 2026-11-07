import { PlanBreadcrumb } from "@/components/explore/PublicBreadcrumb";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { getClassPlanDetail } from "@/lib/data/plan-details";
import {
  viewerSeatAppointmentIds,
  viewerWaitlistAppointmentIds,
} from "@/lib/data/viewer-seats";
import {
  eventPlanMetadata,
  hiddenEventPlanMetadata,
} from "@/lib/seo/event-plan-share";
import { ClassDetails } from "./components/ClassDetails";
import { generateProgramImageUrl } from "@/lib/explore/programs";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: Readonly<{
  params: Promise<{ classPlanId: string }>;
}>): Promise<Metadata> {
  const { classPlanId } = await params;
  const [plan, session] = await Promise.all([
    getClassPlanDetail(classPlanId).catch(() => null),
    getSession().catch(() => null),
  ]);
  // The page's own gate: a draft, archived or ORG_ONLY plan must not leak its
  // title through the tab or a link preview.
  if (!plan || !(await canViewPlanDetail(plan, session))) {
    return hiddenEventPlanMetadata("class");
  }
  return eventPlanMetadata(plan, "class");
}

export default async function ClassDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ classPlanId: string }>;
}>) {
  const { classPlanId } = await params;
  // The plan read is keyed on the URL id and the session read on the cookie —
  // independent, so they run concurrently; the gate reuses the session.
  const [classPlan, session] = await Promise.all([
    getClassPlanDetail(classPlanId),
    getSession().catch((error) => {
      reportSentryError(error, { subsystem: "plans", expected: true });
      return null;
    }),
  ]);

  if (!classPlan) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(classPlan, session))) {
    notFound();
  }

  const planWithDefaults = {
    ...classPlan,
    type: "class" as const,
    imageUrl: generateProgramImageUrl(classPlan.imageUrl),
  };

  const viewerUserId = session?.user?.id ?? null;
  const batchAppointmentIds = classPlan.classes.flatMap((c) =>
    c.appointment ? [c.appointment.id] : [],
  );
  const [enrolledAppointmentIds, waitingAppointmentIds] = await Promise.all([
    viewerSeatAppointmentIds(viewerUserId, batchAppointmentIds),
    viewerWaitlistAppointmentIds(viewerUserId, batchAppointmentIds),
  ]);

  return (
    <>
      <PlanBreadcrumb plan={classPlan} />
      <ClassDetails
        plan={planWithDefaults}
        enrolledAppointmentIds={enrolledAppointmentIds}
        waitingAppointmentIds={waitingAppointmentIds}
        viewerUserId={viewerUserId}
      />
    </>
  );
}
