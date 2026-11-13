"use client";

import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import type { OrgPendingRequest } from "@/lib/data/org-pending-requests";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  bookingStatus,
  bookingStatusBadge,
} from "@/lib/appointments/booking-status";
import { useOrgRole } from "../useOrgRole";
import { AllocateOrgBookingDialog } from "./AllocateOrgBookingDialog";

/**
 * The payer's view of unallocated org-funded requests — Appointments ›
 * Unscheduled. Authorized operators may allocate only a booking the expert has
 * already approved; a request still awaiting the expert carries no Allocate.
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
  const { can } = useOrgRole(orgId);
  const canAllocate =
    canAllocateProp ??
    (Boolean(orgId) && can("appointments.allocate.calendarRead"));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These sessions are funded by your organization and are waiting for
        calendar times. Once the expert approves a request, authorized operators
        can allocate available slots on behalf of the organization with an audit
        justification.
      </p>
      <ResponsiveTable<OrgPendingRequest>
        rows={requests}
        getRowId={(row) => `${row.kind}:${row.id}`}
        empty="Nothing is waiting to be scheduled."
        rowActions={
          canAllocate && orgId
            ? (row) =>
                row.awaitingExpertApproval ? null : (
                  <AllocateOrgBookingDialog
                    orgId={orgId}
                    appointmentId={row.appointmentId ?? row.id}
                    planTitle={row.planTitle}
                    expertName={row.expertName}
                    learnerName={row.learnerName}
                    consultantProfileId={row.consultantProfileId}
                    sessionMinutes={row.sessionMinutes}
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
            key: "status",
            header: "Status",
            cell: (row) => {
              const status = bookingStatus(
                {
                  kind: row.kind,
                  status: row.awaitingExpertApproval ? "PENDING" : "APPROVED",
                  source: "REQUEST_SUBMITTED",
                  sessions: { live: 0, allTentative: false, done: false },
                  names: {
                    consultant: row.expertName ?? "the expert",
                    payer: row.learnerName ?? "the learner",
                  },
                },
                "ORG_ADMIN",
              );
              return (
                <div className="space-y-0.5">
                  <StatusBadge {...bookingStatusBadge(status)} />
                  <p className="text-xs text-muted-foreground">{status.line}</p>
                </div>
              );
            },
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
