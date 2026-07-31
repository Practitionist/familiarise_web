import Link from "next/link";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/**
 * The consultant's slot-allocation surface.
 *
 * Placing N sessions across a scheduling period under per-day and per-week
 * caps is a page-sized task that has been living in a dialog. The heatmap
 * stays — it is the right tool here, unlike on the buyer side — it simply gets
 * room to breathe, plus a URL that survives a refresh and can be linked from
 * the notification that says a request is waiting.
 *
 * Read-only for now: the Requests table links here so the full-width grid can
 * be judged against the dialog it replaces, but every allocation action still
 * lives in that dialog. The next PR moves the actions across and retires it.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
  searchParams: Promise<{ type?: string }>;
};

export default async function AllocateSlotsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // `appointmentId` carries the CONSULTATION/SUBSCRIPTION id, which is what the
  // allocation endpoints and the calendar's event lookup are keyed by — the
  // Appointment row is downstream of it and does not exist for a request that
  // has never been scheduled.
  const { consultantId, appointmentId } = await params;
  const { type } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  // The route cannot say which product this is, and every calendar fetch is
  // keyed by it. The caller already knows, so it travels in the link rather
  // than costing this page a query to re-derive.
  const eventType = type === "subscription" ? "subscription" : "consultation";

  return (
    <div className="flex flex-col gap-4">
      <DashboardHeader
        title="Allocate slots"
        subtitle="Choose times for this booking"
      />

      <Link
        href={`/dashboard/consultant/${consultantId}/requests`}
        className="self-start text-sm font-medium underline underline-offset-4"
      >
        Back to requests
      </Link>

      <DesktopOnlyNotice>
        {/* A min-height, not `flex-1`: this page is a plain block column, so
            the calendar's own `flex-1` has nothing to fill without one. */}
        <SafeUnifiedCalendar
          className="min-h-[70vh]"
          consultantId={consultantId}
          eventType={eventType}
          eventId={appointmentId}
          mode="view"
        />
      </DesktopOnlyNotice>
    </div>
  );
}
