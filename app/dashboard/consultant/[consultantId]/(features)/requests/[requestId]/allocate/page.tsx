import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { readAllocationRequest } from "@/lib/data/allocation-request";

import { AllocateClient } from "./AllocateClient";

/**
 * The consultant's slot-allocation surface.
 *
 * Placing N sessions across a scheduling period under per-day and per-week
 * caps is a page-sized task that was living in a dialog. The heatmap stays —
 * it is the right tool here, unlike on the buyer side — it simply gets room to
 * breathe, plus a URL that survives a refresh and can be linked from the
 * notification that says a request is waiting.
 */
type PageProps = {
  // `requestId` is the CONSULTATION/SUBSCRIPTION id, which is what the
  // allocation endpoints and the grid's event lookup are keyed by. The
  // `Appointment` row is downstream of it and does not exist at all for a
  // request that has never been scheduled — the ordinary case here.
  params: Promise<{ consultantId: string; requestId: string }>;
  searchParams: Promise<{ type?: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadRequest = cache(readAllocationRequest);

/**
 * Names the booking, not the task. A consultant working three requests has
 * three of these tabs open, and "Allocate slots" on all of them tells them
 * nothing (#1064).
 */
export async function generateMetadata({
  params,
  searchParams,
}: Readonly<PageProps>): Promise<Metadata> {
  const { requestId } = await params;
  const { type } = await searchParams;
  const request = await loadRequest(
    requestId,
    type === "subscription" ? "subscription" : "consultation",
  ).catch(() => null);
  if (!request) return { title: "Allocate slots — Familiarise" };

  const who = request.consulteeName ? ` · ${request.consulteeName}` : "";
  return { title: `Allocate: ${request.title}${who} — Familiarise` };
}

export default async function AllocateSlotsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId, requestId } = await params;
  const { type } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  // The route cannot say which product this is, and every grid fetch is keyed
  // by it. The caller already knows, so it travels in the link.
  const eventType = type === "subscription" ? "subscription" : "consultation";

  const request = await loadRequest(requestId, eventType);
  if (!request) notFound();
  // Binds the request to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (request.consultantProfileId !== consultantId) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/requests`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* The BOOKING is the h1, the task is the line under it. Both routes
          reached from the requests table look identical otherwise, and a
          consultant with several open could not tell which one they were
          allocating (#1064). */}
      <DashboardHeader
        title={request.title}
        subtitle={
          request.consulteeName
            ? `Allocate slots for ${request.consulteeName}`
            : "Allocate slots"
        }
      />

      <Link
        href={backHref}
        className="self-start text-sm font-medium underline underline-offset-4"
      >
        Back to requests
      </Link>

      <AllocateClient
        backHref={backHref}
        subject={{
          consultantProfileId: consultantId,
          eventType: request.eventType,
          eventId: request.id,
          counterpartUserId: request.consulteeUserId,
          durationInHours: request.durationInHours,
          sessionDurationInHours: request.sessionDurationInHours,
          sessionsPerWeek: request.sessionsPerWeek,
          durationInMonths: request.durationInMonths,
          totalSessions: request.totalSessions,
          schedulingTimezone: request.schedulingTimezone,
          allowedStart: request.allowedStart,
          allowedEnd: request.allowedEnd,
          hasReleasedSlots: request.hasReleasedSlots,
        }}
      />
    </div>
  );
}
