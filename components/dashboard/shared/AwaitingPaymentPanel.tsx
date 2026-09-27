"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";

import { KeyValueList } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

interface ApprovalPayment {
  id: string;
  /** The booking row, when one exists (a trial may not have one yet). */
  appointmentId: string | null;
  type: "consultation" | "subscription" | "trial";
  title: string;
  consultantName: string;
  consulteeName: string;
  consulteeEmail: string;
  amount: number;
  currency: string;
  paymentUrl: string;
  approvedAt: string;
  expiresAt: string;
  isExpired: boolean;
  isExpiringSoon: boolean;
}

async function fetchApprovalPayments(): Promise<{
  approvalPayments: ApprovalPayment[];
}> {
  const res = await fetch("/api/dashboard/admin/approval-payments");
  if (!res.ok) throw new Error("Failed to fetch approval payments");
  return res.json() as Promise<{ approvalPayments: ApprovalPayment[] }>;
}

function deadline(p: ApprovalPayment) {
  const when = formatDistanceToNow(new Date(p.expiresAt), { addSuffix: true });
  if (p.isExpired) {
    return <StatusBadge label={`Link expired ${when}`} tone="critical" />;
  }
  if (p.isExpiringSoon) {
    return <StatusBadge label={`Expires ${when}`} tone="warning" />;
  }
  return <StatusBadge label={`Expires ${when}`} tone="caution" variant="dot" />;
}

/**
 * #1527 Q9 — approved bookings whose buyer has not paid yet (the old
 * Approval Payments page), as an Appointments tab both trees can see. A row
 * opens its booking, where the Ops actions panel lives; a request with no
 * booking row yet (one is created when the learner pays) opens its request
 * facts instead, so no row is inert (QA B5).
 */
export function AwaitingPaymentPanel({
  onOpenBooking,
}: Readonly<{ onOpenBooking: (appointmentId: string) => void }>) {
  const [request, setRequest] = useState<ApprovalPayment | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["approval-payments"],
    queryFn: fetchApprovalPayments,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const columns: ResponsiveColumn<ApprovalPayment>[] = [
    {
      key: "booking",
      header: "Booking",
      primary: true,
      cell: (p) => (
        <div>
          <p className="font-medium">{p.title}</p>
          <p className="text-xs text-muted-foreground">
            {humanizeEnum(p.type)} · {p.consultantName}
          </p>
        </div>
      ),
    },
    {
      key: "buyer",
      header: "Buyer",
      cell: (p) => (
        <div>
          <p className="text-sm">{p.consulteeName}</p>
          <p className="text-xs text-muted-foreground">{p.consulteeEmail}</p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      cell: (p) => (
        <span className="tabular-nums">
          {formatCurrencyAmount(p.amount, p.currency)}
        </span>
      ),
    },
    { key: "deadline", header: "Pay link", cell: deadline },
  ];

  return (
    <>
      <ResponsiveTable<ApprovalPayment>
        columns={columns}
        rows={data?.approvalPayments ?? []}
        getRowId={(p) => `${p.type}:${p.id}`}
        isLoading={isLoading && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        onRowClick={(p) =>
          p.appointmentId ? onOpenBooking(p.appointmentId) : setRequest(p)
        }
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            Every approved booking has been paid.
          </p>
        }
      />
      <ResponsiveModal
        open={request !== null}
        onOpenChange={(open) => !open && setRequest(null)}
      >
        <ResponsiveModalContent className="sm:max-w-lg">
          {request && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle>{request.title}</ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Approved, not paid yet. The booking, its sessions and its Ops
                  actions are created when the learner pays.
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <KeyValueList
                items={[
                  { label: "Type", value: humanizeEnum(request.type) },
                  { label: "Expert", value: request.consultantName },
                  {
                    label: "Learner",
                    value: request.consulteeName,
                    hint: request.consulteeEmail,
                  },
                  {
                    label: "Amount",
                    value: formatCurrencyAmount(
                      request.amount,
                      request.currency,
                    ),
                  },
                  { label: "Pay link", value: deadline(request) },
                  { label: "Request ID", value: request.id },
                ]}
              />
              <ResponsiveModalFooter>
                <Button variant="outline" onClick={() => setRequest(null)}>
                  Close
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
