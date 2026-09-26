"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";

import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useSession } from "@/lib/auth-client";
import type { Tone } from "@/lib/ui/tone";

import {
  fetchPayoutSetup,
  payoutSetupQueryKey,
  type PayoutAccountView,
  type PayoutSetup,
} from "../settings/payouts/get-paid-api";

/** `ab•••@okaxis` — the owner's own id, still not shouted across the header. */
function maskUpi(upiId: string): string {
  const [local, handle] = upiId.split("@");
  return `${local.slice(0, 2)}•••${handle ? `@${handle}` : ""}`;
}

function accountLabel(account: PayoutAccountView): string {
  if (account.accountType === "UPI" && account.upiId) {
    return `UPI ${maskUpi(account.upiId)}`;
  }
  return `${account.bankName ?? "Bank account"} ••${account.accountNumberLast4 ?? "••"}`;
}

function statusOf(
  setup: PayoutSetup,
  account: PayoutAccountView | undefined,
): { label: string; tone: Tone } {
  if (!account) return { label: "Not set up", tone: "warning" };
  if (!account.isVerified) return { label: "Not verified", tone: "warning" };
  if (setup.requirements.currentlyDue.length > 0) {
    return { label: "Details needed", tone: "warning" };
  }
  return { label: "Ready", tone: "success" };
}

/**
 * #1527 §7.2 — the Earnings header's payout-status chip: where the money goes
 * and whether it can, with "Manage" straight to Settings › Get paid.
 */
export function PayoutStatusChip({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data: session } = useSession();
  // The route is session-derived; the server seed covers inspecting staff.
  const isOwner =
    (session?.user as { consultantProfileId?: string } | undefined)
      ?.consultantProfileId === consultantId;
  const { data } = useQuery({
    queryKey: payoutSetupQueryKey(consultantId),
    queryFn: fetchPayoutSetup,
    enabled: isOwner,
    staleTime: 60_000,
  });
  const manageHref = `/dashboard/consultant/${consultantId}/settings/get-paid`;
  const account = data
    ? (data.accounts.find((a) => a.isDefault) ?? data.accounts[0])
    : undefined;
  const status = data ? statusOf(data, account) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm">
      <Landmark className="h-4 w-4 text-muted-foreground" aria-hidden />
      {data && (
        <span className="text-foreground">
          {account ? accountLabel(account) : "No payout account"}
        </span>
      )}
      {status && (
        <StatusBadge label={status.label} tone={status.tone} size="sm" />
      )}
      <Link
        href={manageHref}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        Manage
      </Link>
    </div>
  );
}
