"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { formatCurrencyAmount } from "@/utils/formatting";

interface Party {
  id: string;
  name: string | null;
  email: string | null;
}

export interface HeldReferralItem {
  id: string;
  heldAt: string | null;
  heldReason: string | null;
  signedUpAt: string;
  qualifiedAt: string | null;
  referredUser: Party;
  referralCode: { code: string; user: Party };
  qualifyingPayment: {
    id: string;
    amount: number;
    capturedAt: string | null;
  } | null;
}

interface HeldResponse {
  data: HeldReferralItem[];
  total: number;
  totalPages: number;
}

type Decision = "RELEASE" | "VOID";

const HOLD_REASON_LABEL: Record<string, string> = {
  SAME_IP: "Same network as other referrals",
  SAME_DEVICE: "Same network and browser as other referrals",
};

const QUERY_KEY = "admin-held-referrals";

/** The page to show once the page count is known: never past the last page, never below 1. */
/** The card title: never "0 held" when the queue could not be read. */
export function headerCount(
  loading: boolean,
  failed: boolean,
  total: number,
): string {
  if (loading) return "Loading…";
  if (failed) return "Held for review";
  return `${total} held for review`;
}

export function clampPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(page, totalPages));
}

function partyLabel(p: Party): string {
  return p.email || p.name || p.id;
}

function fmtDate(d: string | null): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "—";
}

async function fetchHeld(page: number): Promise<HeldResponse> {
  const res = await fetch(`/api/admin/referrals/held?page=${page}&limit=25`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? "Failed to load held referrals",
    );
  }
  return res.json();
}

const COLUMNS: ResponsiveColumn<HeldReferralItem>[] = [
  {
    key: "referee",
    header: "Referred friend",
    primary: true,
    cell: (r) => (
      <span className="truncate font-medium">{partyLabel(r.referredUser)}</span>
    ),
  },
  {
    key: "referrer",
    header: "Referrer",
    cell: (r) => (
      <div className="min-w-0">
        <p className="truncate">{partyLabel(r.referralCode.user)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {r.referralCode.code}
        </p>
      </div>
    ),
  },
  {
    key: "reason",
    header: "Why held",
    cell: (r) =>
      HOLD_REASON_LABEL[r.heldReason ?? ""] ?? r.heldReason ?? "Unknown",
  },
  {
    key: "payment",
    header: "Qualifying payment",
    cell: (r) =>
      r.qualifyingPayment
        ? formatCurrencyAmount(r.qualifyingPayment.amount, "INR")
        : "—",
  },
  {
    key: "heldAt",
    header: "Held on",
    cell: (r) => fmtDate(r.heldAt),
  },
];

function DecisionDialog({
  referral,
  decision,
  onClose,
}: Readonly<{
  referral: HeldReferralItem;
  decision: Decision;
  onClose: () => void;
}>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const release = decision === "RELEASE";

  const mutation = useMutation({
    mutationFn: async (auditReason: string) => {
      const res = await fetch(`/api/admin/referrals/held/${referral.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: auditReason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Failed to decide referral",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleConfirm = () => {
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      setError("Audit reason must be at least 5 characters.");
      return;
    }
    mutation.mutate(trimmed);
  };

  return (
    <ResponsiveModal open onOpenChange={(v) => !v && onClose()}>
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            {release ? "Release referral" : "Void referral"}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {release
              ? "The referral goes back to waiting, and the next vest run settles it as usual."
              : "The referral is voided and the referrer's pending credit with it."}{" "}
            Friend:{" "}
            <strong className="text-foreground">
              {partyLabel(referral.referredUser)}
            </strong>
            .
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="held-decision-reason">Audit reason *</Label>
            <Input
              id="held-decision-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Checked: same household, genuine friend"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <ResponsiveModalFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={release ? "default" : "destructive"}
            onClick={handleConfirm}
            disabled={mutation.isPending}
          >
            {mutation.isPending && (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            )}
            {release ? "Release" : "Void"}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

/** ADMIN's "Held for review" queue: referrals the vest sweep held, each released or voided. */
export function HeldReferralsPanel() {
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<{
    referral: HeldReferralItem;
    decision: Decision;
  } | null>(null);

  const query = useQuery({
    queryKey: [QUERY_KEY, { page }],
    queryFn: () => fetchHeld(page),
  });
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = query.data?.totalPages ?? 1;

  // Deciding the last row of the last page shrinks the page count under the current page.
  useEffect(() => {
    if (!query.data) return;
    const clamped = clampPage(page, query.data.totalPages);
    if (clamped !== page) setPage(clamped);
  }, [page, query.data]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {headerCount(query.isLoading, query.error !== null, total)}
          </CardTitle>
          <CardDescription>
            Referrals whose sign-up signals matched a review rule. Nothing vests
            until an admin releases or voids them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading held
              referrals…
            </div>
          )}
          {query.error && (
            <p className="text-sm text-red-600">{query.error.message}</p>
          )}
          {!query.isLoading && !query.error && rows.length === 0 && (
            <div className="py-12 text-center text-muted-foreground">
              <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm">No referrals are held for review.</p>
            </div>
          )}
          {rows.length > 0 && (
            <ResponsiveTable<HeldReferralItem>
              columns={COLUMNS}
              rows={rows}
              getRowId={(r) => r.id}
              rowActions={(r) => (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setTarget({ referral: r, decision: "RELEASE" })
                    }
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Release
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => setTarget({ referral: r, decision: "VOID" })}
                  >
                    <XCircle className="mr-1 h-3.5 w-3.5" /> Void
                  </Button>
                </div>
              )}
            />
          )}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {target && (
        <DecisionDialog
          referral={target.referral}
          decision={target.decision}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}
