"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { errorMessageFromBody } from "@/lib/fetch-helpers";

type Recipient = "SELF" | "ORGANIZATION";

interface ExpertRouting {
  membershipId: string;
  name: string | null;
  payoutRecipient: Recipient;
}

const RECIPIENT_LABEL: Record<Recipient, string> = {
  SELF: "Paid to the expert",
  ORGANIZATION: "Paid to this organization",
};

const other = (r: Recipient): Recipient =>
  r === "SELF" ? "ORGANIZATION" : "SELF";

/**
 * Payouts › Experts' payout routing (#1846): whether each expert's share of a
 * session is paid to the expert or to this organization. A Billing admin can
 * reach it without the member list, and the server returns only each
 * expert's name and recipient. Changes are OWNER + BILLING_ADMIN on the
 * server (`payouts.manage` here).
 */
export function ExpertPayoutRoutingPanel({
  orgId,
  canManage,
}: Readonly<{ orgId: string; canManage: boolean }>) {
  const queryClient = useQueryClient();
  const queryKey = ["org-expert-payout-routing", orgId];
  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: async (): Promise<ExpertRouting[]> => {
      const res = await fetch(
        `/api/organizations/${orgId}/expert-payout-routing`,
      );
      if (!res.ok) throw new Error("Failed to load experts' payout routing");
      return ((await res.json()) as { data: ExpertRouting[] }).data;
    },
  });

  const change = async (row: ExpertRouting) => {
    const res = await fetch(
      `/api/organizations/${orgId}/expert-payout-routing`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          membershipId: row.membershipId,
          payoutRecipient: other(row.payoutRecipient),
        }),
      },
    );
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(errorMessageFromBody(json, "Couldn't change routing."));
    }
    await queryClient.invalidateQueries({ queryKey });
  };

  const columns: ResponsiveColumn<ExpertRouting>[] = [
    {
      key: "name",
      header: "Expert",
      primary: true,
      cell: (r) => r.name ?? "Unnamed expert",
    },
    {
      key: "recipient",
      header: "Paid to",
      cell: (r) => RECIPIENT_LABEL[r.payoutRecipient],
    },
  ];

  const renderActions = (row: ExpertRouting) =>
    canManage ? (
      <ConfirmDialog
        title="Change where this expert is paid?"
        description={`Earnings recorded from now on pay ${
          row.name ?? "this expert"
        }'s share ${
          other(row.payoutRecipient) === "SELF"
            ? "to the expert directly"
            : "to this organization"
        }. Earnings already recorded keep their routing.`}
        confirmLabel="Change routing"
        onConfirm={() => change(row)}
        trigger={
          <Button size="sm" variant="ghost">
            Change
          </Button>
        }
      />
    ) : null;

  return (
    <Section
      title="Experts' payout routing"
      description="Whether each expert's share of a session is paid to the expert or to this organization."
    >
      {isError ? (
        <ErrorState
          title="Couldn't load experts' payout routing"
          onRetry={() => void refetch()}
        />
      ) : (
        <ResponsiveTable<ExpertRouting>
          columns={columns}
          rows={data ?? []}
          getRowId={(r) => r.membershipId}
          rowActions={renderActions}
          isLoading={isPending}
          empty="No experts in this organization yet."
        />
      )}
    </Section>
  );
}
