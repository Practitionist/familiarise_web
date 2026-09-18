import { cache } from "react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { ALLOCATION_APPROVABLE_FROM } from "@/lib/booking/transitions";
import { readAllocationRequest } from "@/lib/data/allocation-request";
import { isEventIdFormat } from "@/schemas/slotAllocation/validationSchemas";

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
  // `at` pins the grid on one instant — the confirm dialog's "Pick another
  // time" hand-off sends the consultee's requested slot here (#1703 F5).
  searchParams: Promise<{ type?: string; at?: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadRequest = cache(readAllocationRequest);

/** The two products this page can place. Anything else is not a type. */
type AllocationPageEventType = "subscription" | "consultation";

/**
 * Parses ?type without a ternary train and without assertions: the explicit
 * return type narrows each case arm to its literal, and anything unlisted
 * (missing, garbage, wrong case) is null rather than silently consultation.
 */
function parseEventTypeParam(
  type: string | undefined,
): AllocationPageEventType | null {
  switch (type) {
    case "subscription":
      return "subscription";
    case "consultation":
      return "consultation";
    default:
      return null;
  }
}

/** The pinned instant, or null when `?at` is absent or not a date. */
function parsePinnedAt(at: string | undefined): Date | null {
  if (!at) return null;
  const parsed = new Date(at);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Names the booking, not the task. A consultant working three requests has
 * three of these tabs open, and "Allocate slots" on all of them tells them
 * nothing (#1064).
 */
export async function generateMetadata({
  params,
  searchParams,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consultantId, requestId } = await params;
  const { type } = await searchParams;
  const request = await loadRequest(
    requestId,
    type === "subscription" ? "subscription" : "consultation",
  ).catch(() => null);
  // Metadata runs BEFORE the body's guards and is not covered by them, so the
  // same ownership check runs here — otherwise the tab title named the
  // offering and the buyer for any request id a signed-in consultant tried.
  if (!request || request.consultantProfileId !== consultantId) {
    return { title: "Allocate slots — Familiarise" };
  }

  const who = request.consulteeName ? ` · ${request.consulteeName}` : "";
  return { title: `Allocate: ${request.title}${who} — Familiarise` };
}

export default async function AllocateSlotsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId, requestId } = await params;
  const { type, at } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  // Malformed ids fail fast without a DB hit.
  if (!isEventIdFormat(requestId)) notFound();

  // The route cannot say which product this is, and every grid fetch is keyed
  // by it. The caller already knows, so it travels in the link — but links
  // get stripped and hand-edited, so a missing or wrong ?type resolves
  // canonically instead of 404ing a valid request: look under the named
  // table first, then the other one, redirecting to the canonical URL.
  // The grid subject below still comes from the DB read, never from ?type.
  const requestedType = parseEventTypeParam(type);
  const canonicalPath = (eventType: AllocationPageEventType) =>
    `/dashboard/consultant/${encodeURIComponent(consultantId)}/requests/${encodeURIComponent(requestId)}/allocate?type=${eventType}`;

  const request = requestedType
    ? await loadRequest(requestId, requestedType)
    : null;
  if (!request) {
    const fallbackType =
      requestedType === "subscription" ? "consultation" : "subscription";
    const fallback = await loadRequest(requestId, fallbackType);
    if (!fallback) notFound();
    redirect(canonicalPath(fallbackType));
  }

  // Binds the request to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (request.consultantProfileId !== consultantId) notFound();
  // This URL outlives the work: it is linkable from a notification, survives a
  // refresh, and goBack() pushes, so the back button returns here once the
  // allocation is done. Without this a consultant reopens a live grid for a
  // request that is already cancelled, rejected or fully placed.
  //
  // ALLOCATION_APPROVABLE_FROM, not `=== PENDING`: a partial reschedule is
  // allocated from this same page, and a subscription is deliberately NOT
  // flipped back to PENDING when one of its sessions is released (#448), so it
  // arrives here still APPROVED.
  //
  // Friendly dead-link for the owner (reached only past the ownership gate
  // above, so no existence oracle for strangers): a stale notification link
  // explains itself instead of 404ing.
  const backHref = `/dashboard/consultant/${encodeURIComponent(consultantId)}/requests`;
  if (!ALLOCATION_APPROVABLE_FROM.includes(request.status)) {
    return (
      <DashboardViewportFill className="gap-4">
        <div className="shrink-0 rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">
            This request is no longer available for allocation
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {request.status === "SCHEDULED" || request.status === "COMPLETED"
              ? "Its sessions already have times."
              : "It was cancelled, declined, or expired."}{" "}
            <a className="underline" href={backHref}>
              Back to requests
            </a>
          </p>
        </div>
      </DashboardViewportFill>
    );
  }

  return (
    <DashboardViewportFill className="gap-4">
      <AllocateClient
        backHref={backHref}
        title={request.title}
        pinnedAt={parsePinnedAt(at)}
        subject={{
          consultantProfileId: consultantId,
          eventType: request.eventType,
          eventId: request.id,
          counterpartUserId: request.consulteeUserId,
          // Who the task is for — rendered into the picker's hint line now
          // that the page carries no separate heading for it.
          consulteeName: request.consulteeName,
          durationInHours: request.durationInHours,
          sessionDurationInHours: request.sessionDurationInHours,
          sessionsPerWeek: request.sessionsPerWeek,
          durationInMonths: request.durationInMonths,
          totalSessions: request.totalSessions,
          schedulingTimezone: request.schedulingTimezone,
          allowedStart: request.allowedStart,
          allowedEnd: request.allowedEnd,
          hasReleasedSlots: request.hasReleasedSlots,
          slots: request.slots,
        }}
      />
    </DashboardViewportFill>
  );
}
