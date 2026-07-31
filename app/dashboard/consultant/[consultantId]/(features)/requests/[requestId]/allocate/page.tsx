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

  const request = await readAllocationRequest(requestId, eventType);
  if (!request) notFound();
  // Binds the request to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (request.consultantProfileId !== consultantId) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/requests`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DashboardHeader
        title="Allocate slots"
        subtitle={
          request.consulteeName
            ? `${request.title} for ${request.consulteeName}`
            : request.title
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
