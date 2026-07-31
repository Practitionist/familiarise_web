import Link from "next/link";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

/**
 * Skeleton for the consultee's reschedule surface.
 *
 * The picker lives in a modal today, and every defect found reviewing it —
 * labels overflowing their column, a legend that would not fit, a selection
 * lost on reload — traced back to width. A route also gives the flow a URL,
 * so "pick a new time" in a notification can link straight here, and a
 * half-finished choice survives a refresh.
 *
 * Deliberately not wired up yet: nothing links to this route, so it cannot
 * affect the working modal. The next PR moves the picker in and adds the
 * navigation. What is real here is the route, the ownership check and the
 * mobile gate — the parts worth settling before any UI is built on them.
 */
type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
};

export default async function RescheduleAppointmentPage({
  params,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultee", consulteeId);

  return (
    <div className="flex flex-col gap-4">
      <DashboardHeader
        title="Reschedule"
        subtitle="Choose a new time for your session"
      />

      <DesktopOnlyNotice>
        <div className="rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            The time picker is moving here from the dialog. For now, reschedule
            from the booking&apos;s menu on the appointments page.
          </p>
          <Link
            href={`/dashboard/consultee/${consulteeId}/appointments`}
            className="mt-4 inline-block text-sm font-medium underline underline-offset-4"
          >
            Back to appointments
          </Link>
        </div>
      </DesktopOnlyNotice>

      {/* Kept in the DOM so the route's contract is visible while it is a
          skeleton: this page is per-appointment, not a generic picker. */}
      <span className="sr-only">Appointment {appointmentId}</span>
    </div>
  );
}
