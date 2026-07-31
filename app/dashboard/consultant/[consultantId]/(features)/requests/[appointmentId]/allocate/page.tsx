import Link from "next/link";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/**
 * Skeleton for the consultant's slot-allocation surface.
 *
 * Placing N sessions across a scheduling period under per-day and per-week
 * caps is a page-sized task that has been living in a dialog. The heatmap
 * stays — it is the right tool here, unlike on the buyer side — it simply gets
 * room to breathe, plus a URL that survives a refresh and can be linked from
 * the notification that says a request is waiting.
 *
 * Deliberately not wired up yet: nothing links to this route, so the working
 * dialog is untouched. The next PR moves the calendar in. What is real here is
 * the route, the ownership check and the mobile gate.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

export default async function AllocateSlotsPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  return (
    <div className="flex flex-col gap-4">
      <DashboardHeader
        title="Allocate slots"
        subtitle="Choose times for this booking"
      />

      <DesktopOnlyNotice>
        <div className="rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            The allocation calendar is moving here from the dialog. For now,
            allocate from the Requests table.
          </p>
          <Link
            href={`/dashboard/consultant/${consultantId}/requests`}
            className="mt-4 inline-block text-sm font-medium underline underline-offset-4"
          >
            Back to requests
          </Link>
        </div>
      </DesktopOnlyNotice>

      {/* Kept in the DOM so the route's contract is visible while it is a
          skeleton: this page allocates ONE booking, not a queue. */}
      <span className="sr-only">Appointment {appointmentId}</span>
    </div>
  );
}
