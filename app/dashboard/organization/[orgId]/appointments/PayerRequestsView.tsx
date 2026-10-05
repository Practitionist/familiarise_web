"use client";

import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import type { OrgPendingRequest } from "@/lib/data/org-pending-requests";
import { useOrgRole } from "../useOrgRole";
import { AllocateOrgBookingDialog } from "./AllocateOrgBookingDialog";

/**
 * The payer's view of unallocated org-funded requests — Appointments ›
 * Unscheduled. Authorized operators (OWNER, MAINTAINER, MANAGER) can also
 * allocate slots on behalf of the organization with an explicit audit reason.
 */
export function PayerRequestsView({
  orgId: orgIdProp,
  requests,
  canAllocate: canAllocateProp,
}: Readonly<{
  orgId?: string;
  requests: OrgPendingRequest[];
  canAllocate?: boolean;
}>) {
  const params = useParams<{ orgId?: string }>();
  const orgId = orgIdProp ?? params?.orgId ?? "";
  const { role, can } = useOrgRole(orgId);
  const canAllocate =
    canAllocateProp ??
    (Boolean(orgId) &&
      (can("appointments.allocate.calendarRead") || role === "MANAGER"));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These sessions are funded by your organization and are waiting for
        calendar times. Authorized operators can allocate available slots on
        behalf of the organization with an audit justification.
      </p>
      <ResponsiveTable<OrgPendingRequest>
        rows={requests}
        getRowId={(row) => `${row.kind}:${row.id}`}
        empty="Nothing is waiting to be scheduled."
        rowActions={
          canAllocate && orgId
            ? (row) => (
                <AllocateOrgBookingDialog
                  orgId={orgId}
                  appointmentId={row.appointmentId ?? row.id}
                  planTitle={row.planTitle}
                  expertName={row.expertName}
                  learnerName={row.learnerName}
                />
              )
            : undefined
        }
        columns={[
          {
            key: "plan",
            header: "Session",
            primary: true,
            cell: (row) => row.planTitle,
          },
          {
            key: "learner",
            header: "Requested by",
            cell: (row) => row.learnerName ?? "—",
          },
          {
            key: "expert",
            header: "Expert",
            cell: (row) => row.expertName ?? "—",
          },
          {
            key: "kind",
            header: "Type",
            cell: (row) => (
              <Badge variant="secondary">
                {row.kind === "CONSULTATION" ? "Consultation" : "Subscription"}
              </Badge>
            ),
          },
          {
            key: "requestedAt",
            header: "Requested",
            cell: (row) => new Date(row.requestedAt).toLocaleDateString(),
          },
        ]}
      />
    </div>
  );
}
