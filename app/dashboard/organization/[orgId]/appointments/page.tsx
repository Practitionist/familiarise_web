import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { isPayerAdminRole } from "@/lib/booking/org-actor";
import {
  getOrgAppointments,
  getOrgMemberAppointments,
} from "@/lib/data/org-appointments";
import { readOrgPendingRequests } from "@/lib/data/org-pending-requests";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import StreamProvider from "@/providers/StreamProvider";

import { AppointmentsPageClient } from "./AppointmentsPageClient";
import {
  MyAppointmentsClient,
  type MyAppointmentItem,
} from "./MyAppointmentsClient";
import { PayerRequestsView } from "./PayerRequestsView";
import { AppointmentTabs, type AppointmentTab } from "./AppointmentTabs";

/** Which tab the URL asks for, falling back to "mine" when not allowed. */
function resolveTab(
  sp: { tab?: string; scope?: string },
  available: AppointmentTab[],
): AppointmentTab {
  // `?scope=everyone` predates the tabs; old links keep working.
  const requested = sp.tab ?? sp.scope;
  return available.find((t) => t === requested) ?? "mine";
}

/**
 * /dashboard/organization/[orgId]/appointments — Mine · Everyone · Unscheduled.
 *
 * "Mine" is the member's own participation (attending or delivering);
 * "Everyone" is the org-wide operations feed (`operations.read`);
 * "Unscheduled" is the payer admins' view of org-funded requests nobody has
 * put times on yet (#1527 Q7, moved from Requests).
 *
 * Access floors at active membership: a pure learner must see their own
 * sessions. A viewer asking for a tab they can't use is quietly served
 * "Mine" — no error page for a URL they could only have reached by editing it.
 */
export default async function OrgAppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ tab?: string; scope?: string; page?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;

  // Floor at active membership — requireOrgAccess rejects non-members, and we
  // keep the URL tree honest with a 404 rather than leaking the shell.
  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  const role = access.member.role;
  const available: AppointmentTab[] = ["mine"];
  if (hasOrgPermission(role, "operations.read")) available.push("everyone");
  if (isPayerAdminRole(role)) available.push("unscheduled");
  const tab = resolveTab(sp, available);

  const rawPage = Number(sp.page ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const descriptions: Record<AppointmentTab, string> = {
    mine: `Sessions you're attending or delivering under ${access.org.name}.`,
    everyone: `All bookings made under ${access.org.name}.`,
    unscheduled: `Bookings ${access.org.name} funded that are still waiting on times.`,
  };
  const header = (
    <DashboardHeader
      title="Appointments"
      description={descriptions[tab]}
      actions={<AppointmentTabs active={tab} available={available} />}
    />
  );

  if (tab === "everyone") {
    const queryClient = new QueryClient();
    // #890 — prefetch only the default page; filtered/paged views diverge by
    // queryKey and fall back to the client fetch. The trailing `undefined` is
    // the appointmentType filter and MUST be present: the client's key carries
    // that slot, and ["...", 1] wouldn't match ["...", 1, undefined].
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-appointments", orgId, page, undefined],
        queryFn: () => getOrgAppointments(orgId, { page }),
      }),
    ]);

    return (
      <>
        {header}
        <DashboardContent>
          <HydrationBoundary state={dehydrate(queryClient)}>
            <AppointmentsPageClient orgId={orgId} />
          </HydrationBoundary>
        </DashboardContent>
      </>
    );
  }

  if (tab === "unscheduled") {
    const requests = await readOrgPendingRequests(orgId);
    return (
      <>
        {header}
        <DashboardContent>
          <PayerRequestsView requests={requests} />
        </DashboardContent>
      </>
    );
  }

  const userId = access.session.user.id;
  const { items, total, perPage } = await getOrgMemberAppointments(
    orgId,
    userId,
    { page },
  );

  return (
    <>
      {header}
      <DashboardContent>
        {/* Video-only Stream client, scoped to this subtree so Join has a
            connected client without connecting video on every org route. */}
        <StreamProvider userId={userId} enableChat={false} enableVideo={true}>
          <MyAppointmentsClient
            orgId={orgId}
            viewerId={userId}
            items={items as unknown as MyAppointmentItem[]}
            total={total}
            page={page}
            perPage={perPage}
          />
        </StreamProvider>
      </DashboardContent>
    </>
  );
}
