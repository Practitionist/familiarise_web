import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Badge } from "@/components/ui/badge";
import { readManageTimingsTarget } from "@/lib/data/manage-timings-target";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { buildManageTimingsSubject } from "@/lib/scheduling/manage-timings-subject";

import { ManageTimingsClient } from "./ManageTimingsClient";

/**
 * The consultant setting the times of their own event instance — the fourth
 * caller of the shared slot-picker surface, and the one `SlotPicker` was
 * generalised FROM. It stayed a dialog the longest because nothing here felt
 * per-appointment enough to deserve a URL; cramped on a real calendar grid
 * regardless, so it gets the same page treatment as the other three.
 *
 * `[appointmentId]` carries two different id shapes here, same as the list
 * that links here: a real `Appointment` row's id once one exists, or the
 * `unscheduled-class-<id>` / `unscheduled-webinar-<id>` synthetic id for an
 * offering that has never been scheduled — see manage-timings-target.ts.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadTarget = cache(readManageTimingsTarget);

/**
 * Names the offering, not the task. A consultant with several unscheduled
 * classes had identical "Manage timings" tabs otherwise (#1064).
 */
export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consultantId, appointmentId } = await params;
  const target = await loadTarget(appointmentId).catch(() => null);
  if (!target) return { title: "Manage timings — Familiarise" };

  const resolved = buildManageTimingsSubject(consultantId, target.appointment);
  return { title: `Manage timings: ${resolved.title} — Familiarise` };
}

export default async function ManageTimingsPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  const target = await loadTarget(appointmentId);
  if (!target) notFound();

  // The route's consultant must own the plan or be an ACCEPTED collaborator.
  // Binds the offering to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (!target.planOwnerIds.includes(consultantId)) notFound();

  const resolved = buildManageTimingsSubject(
    consultantId,
    target.appointment,
    target.completedSessions,
    target.groupTotalSessions,
  );

  const backHref = `/dashboard/consultant/${consultantId}/appointments`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* The OFFERING now lives in the breadcrumb (ManageTimingsClient sets it
          via useSetBreadcrumbLabel) — see the reschedule/allocate pages
          (#1064). */}
      <PanelHeader description={resolved.description} />

      {resolved.classInfo && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Plan: {resolved.classInfo.planType}</Badge>
          <span>
            {resolved.classInfo.sessionsPerWeek} meetings/week ·{" "}
            {resolved.classInfo.durationInMonths} month
            {resolved.classInfo.durationInMonths !== 1 ? "s" : ""} ·{" "}
            {resolved.classInfo.durationInHours}h/session
          </span>
        </div>
      )}

      {resolved.classInfo && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
          Tip: Each class is{" "}
          {Math.ceil(resolved.classInfo.durationInHours / 0.5)} consecutive
          30-min slots. Complete an in-progress class before starting another.
          Max {resolved.classInfo.sessionsPerWeek} classes per day; weekly
          limit applies.
        </div>
      )}

      <ManageTimingsClient
        subject={resolved.subject}
        backHref={backHref}
        title={resolved.title}
      />
    </div>
  );
}
