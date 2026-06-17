"use client";

/**
 * Org-scoped appointments dashboard (#674 / B1-hybrid). MANAGER+ at the
 * org. Calls `/api/organizations/[orgId]/appointments` which is forced
 * to scope=org:<orgId> server-side; the route also auth-gates via
 * `requireOrgAccess`.
 *
 * The server page (#890) prefetches the default page (page 1, no filters)
 * into the queryKey ["org-appointments", orgId, 1], so the first paint
 * hydrates without a fetch. Pagination beyond page 1 falls back to the
 * client fetch below.
 */

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import {
  ScopedListTable,
  type Column,
} from "@/components/enterprise/ScopedListTable";

interface AppointmentRow {
  id: string;
  appointmentType: string;
  createdAt: string;
  organizationId: string | null;
  consultation: {
    consultationPlan: { title: string };
    requestedBy: { user: { id: string; name: string | null; email: string } };
  } | null;
  subscription: {
    subscriptionPlan: { title: string };
    requestedBy: { user: { id: string; name: string | null; email: string } };
  } | null;
  webinar: { webinarPlan: { title: string } } | null;
  class: { classPlan: { title: string } } | null;
  trialSession: {
    consulteeProfile: {
      user: { id: string; name: string | null; email: string };
    };
    consultantProfile: {
      user: { id: string; name: string | null; email: string };
    };
  } | null;
}

interface AppointmentsResponse {
  items: AppointmentRow[];
  total: number;
  page: number;
  perPage: number;
}

function getPlanTitle(row: AppointmentRow): string {
  return (
    row.consultation?.consultationPlan?.title ??
    row.subscription?.subscriptionPlan?.title ??
    row.webinar?.webinarPlan?.title ??
    row.class?.classPlan?.title ??
    row.trialSession?.consulteeProfile?.user?.name ??
    "—"
  );
}

function getMember(row: AppointmentRow): string {
  const u =
    row.consultation?.requestedBy?.user ??
    row.subscription?.requestedBy?.user ??
    row.trialSession?.consulteeProfile?.user;
  return u ? (u.name || u.email) : "—";
}

const COLUMNS: Column<AppointmentRow>[] = [
  {
    header: "Type",
    accessor: (r) => <Badge variant="outline">{r.appointmentType}</Badge>,
  },
  { header: "Plan / Title", accessor: (r) => getPlanTitle(r) },
  { header: "Member", accessor: (r) => getMember(r) },
  {
    header: "Booked",
    accessor: (r) => format(new Date(r.createdAt), "PP"),
  },
];

export function AppointmentsPageClient({ orgId }: { orgId: string }) {
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<AppointmentsResponse>({
    queryKey: ["org-appointments", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/appointments?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <DashboardHeader
        title="Appointments"
        subtitle="All bookings made under this organization."
      />
      <DashboardContent>
        <ScopedListTable
          title="Org appointments"
          description="Sessions booked by members of this organization or scoped to a member's program assignment."
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No appointments under this organization yet. Member bookings will surface here once stamped via checkout (B1-hybrid)."
        />
      </DashboardContent>
    </>
  );
}
