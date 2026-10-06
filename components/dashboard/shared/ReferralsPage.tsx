"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { EmptyState, DataCardSkeleton } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { referralStatusBadge } from "@/lib/labels/session-labels";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  Users,
  Gift,
  IndianRupee,
  Copy,
  Check,
  Mail,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { WhatsAppIcon } from "@/components/icons/WhatsAppIcon";
import {
  referralTermsSchema,
  type ReferralTerms,
} from "@/lib/referrals/promo-math";
import type { ReferralStatus } from "@prisma/client";
import { creditSourceLabel } from "@/lib/labels/credit-source";
import Link from "next/link";

interface ReferralCode {
  id: string;
  code: string;
  customCode: string | null;
  referrerReward: number;
  refereeReward: number;
  totalReferrals: number;
  successfulReferrals: number;
  totalEarned: number;
  isActive: boolean;
  maxReferrals: number;
  weekVests?: number;
  weeklyVestCap?: number;
}

export interface ConsultantFeeWaiverItem {
  id: string;
  reason?: string;
  sessionsRemaining: number;
  sessionsGranted: number;
  expiresAt: string;
}

/** A friend counts as qualified once their first paid booking is captured. */
const QUALIFIED_STATUSES: ReadonlySet<ReferralStatus> = new Set([
  "QUALIFIED",
  "REWARDED",
  "QUALIFYING",
  "VESTED",
]);
/** Statuses whose referrer reward has been released. */
const REWARDED_STATUSES: ReadonlySet<ReferralStatus> = new Set([
  "REWARDED",
  "VESTED",
]);

interface Referral {
  id: string;
  status: ReferralStatus;
  signedUpAt: string;
  qualifiedAt: string | null;
  referrerRewardAmount: number;
  refereeRewardAmount: number;
  referredUser: { name: string; image: string | null };
}

export type CreditVestingState = "PENDING" | "VESTED" | "EXPIRED" | "VOID";

interface CreditData {
  totalAvailable: number;
  history: {
    id: string;
    amount: number;
    remainingAmount: number;
    source: string;
    state?: CreditVestingState;
    createdAt: string;
    expiresAt: string | null;
  }[];
}

function resolveCreditRowState(
  credit: CreditData["history"][number],
): CreditVestingState {
  if (
    credit.state === "PENDING" ||
    credit.state === "VESTED" ||
    credit.state === "EXPIRED" ||
    credit.state === "VOID"
  ) {
    return credit.state;
  }
  if (credit.expiresAt && new Date(credit.expiresAt).getTime() <= Date.now()) {
    return "EXPIRED";
  }
  return "VESTED";
}

function creditStateBadge(state: CreditVestingState): {
  label: string;
  tone: "warning" | "success" | "neutral" | "critical";
} {
  switch (state) {
    case "PENDING":
      return { label: "PENDING", tone: "warning" };
    case "VESTED":
      return { label: "VESTED", tone: "success" };
    case "EXPIRED":
      return { label: "EXPIRED", tone: "neutral" };
    case "VOID":
      return { label: "VOID", tone: "critical" };
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatAmount(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(paise / 100);
}

export interface ReferralsPageProps {
  /**
   * Which dashboard is mounting this. The data is identical for both —
   * every `/api/referrals/*` endpoint keys off the session, not a profile —
   * so this only drives presentation: consultants see what they've earned
   * and can customise their code; consultees see credit toward their next
   * booking.
   */
  role: "CONSULTANT" | "CONSULTEE";
  /**
   * Where the tree already lists credits (the consultee's Payments › Credits).
   */
  creditsHref?: string;
}

export function ReferralsPage({
  role,
  creditsHref,
}: Readonly<ReferralsPageProps>) {
  const isConsultant = role === "CONSULTANT";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [customCode, setCustomCode] = useState("");

  const {
    data: codeData,
    isLoading: codeLoading,
    error: codeError,
    refetch: refetchCode,
  } = useQuery<{
    data: ReferralCode;
    terms: ReferralTerms | null;
    feeWaivers: ConsultantFeeWaiverItem[];
  }>({
    queryKey: ["referral-code"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/code", { method: "POST" });
      if (!res.ok) throw new Error("Failed to fetch referral code");
      const body: {
        data: ReferralCode;
        terms?: unknown;
        feeWaivers?: ConsultantFeeWaiverItem[];
      } = await res.json();
      const terms = referralTermsSchema.safeParse(body.terms);
      return {
        data: body.data,
        terms: terms.success ? terms.data : null,
        feeWaivers: Array.isArray(body.feeWaivers) ? body.feeWaivers : [],
      };
    },
    staleTime: 60_000,
  });

  const {
    data: referralsData,
    isLoading: referralsLoading,
    error: referralsError,
    refetch: refetchReferrals,
  } = useQuery<{ data: Referral[] }>({
    queryKey: ["referrals"],
    queryFn: async () => {
      const res = await fetch("/api/referrals");
      if (!res.ok) throw new Error("Failed to fetch referrals");
      return res.json();
    },
    staleTime: 30_000,
  });

  const {
    data: creditsData,
    isLoading: creditsLoading,
    error: creditsError,
    refetch: refetchCredits,
  } = useQuery<{ data: CreditData }>({
    queryKey: ["referral-credits"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/credits");
      if (!res.ok) throw new Error("Failed to fetch credits");
      return res.json();
    },
    staleTime: 30_000,
  });

  const code = codeData?.data;
  const terms = codeData?.terms ?? null;
  const feeWaivers = codeData?.feeWaivers ?? [];
  const friendOffer = terms
    ? `${terms.discountPercent}% off your first booking, up to ${formatAmount(terms.discountMaxPaise)}`
    : null;
  const referrals = referralsData?.data ?? [];
  const credits = creditsData?.data;
  const totalReferred = referrals.length;
  const qualified = referrals.filter((r) =>
    QUALIFIED_STATUSES.has(r.status),
  ).length;
  // `window` is only safe here because `code` happens to be undefined on the
  // server pass today. Add an SSR prefetch for ["referral-code"] — the exact
  // pattern this PR introduces elsewhere — and rendering it would throw
  // "window is not defined" and take the route down. Read the origin after
  // mount instead, so the safety is structural rather than incidental.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const referralLink =
    code && origin ? `${origin}/r/${code.customCode || code.code}` : "";

  const sharePitch = friendOffer
    ? `Use my referral link to get ${friendOffer}`
    : "Join with my referral link";
  const shareSubject = friendOffer
    ? `Get ${friendOffer} on Familiarise`
    : "Join me on Familiarise";
  const capNote = terms
    ? `, and can cover up to ${terms.redemptionCapPercent}% of a booking`
    : "";
  const balanceTooltip = `Credit you can spend now. Credit from a referral becomes spendable after your friend's first session${capNote}.`;
  const shareMessage = referralLink
    ? `I've been using Familiarise. ${sharePitch}: ${referralLink}`
    : "";
  const whatsappUrl = referralLink
    ? `https://wa.me/?text=${encodeURIComponent(shareMessage)}`
    : "";
  const emailUrl = referralLink
    ? `mailto:?subject=${encodeURIComponent(shareSubject)}&body=${encodeURIComponent(shareMessage)}`
    : "";

  const handleCopy = () => {
    // writeText rejects on a denied permission or a non-secure context. It was
    // neither awaited nor caught, so the user got "Referral link copied!" and
    // an empty clipboard.
    navigator.clipboard.writeText(referralLink).then(
      () => {
        setCopied(true);
        toast({ title: "Referral link copied!" });
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        toast({
          title: "Couldn't copy the link",
          description: "Copy it manually from the field above.",
          variant: "destructive",
        });
      },
    );
  };

  // Through the mutation layer like every other write on this page: a network
  // throw was previously an unhandled rejection with no toast, and nothing
  // disabled the button in flight, so a double-click issued two POSTs.
  const customizeMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch("/api/referrals/code/customize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customCode: code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to set custom code");
      }
      return res.json().catch(() => null);
    },
    onSuccess: () => {
      toast({ title: "Custom code set!" });
      setCustomCode("");
      queryClient.invalidateQueries({ queryKey: ["referral-code"] });
    },
    onError: (err: Error) => {
      toast({
        title: err.message || "Failed to set custom code",
        variant: "destructive",
      });
    },
  });

  const handleCustomize = () => {
    const trimmed = customCode.trim();
    if (!trimmed) return;
    customizeMutation.mutate(trimmed);
  };

  const statsLoading = referralsLoading || creditsLoading || codeLoading;
  // codeError belongs here: the "Total Earned" card reads `code?.totalEarned`,
  // so without it a failed code fetch rendered a confident ₹0.00 while every
  // neighbouring card fell back to "—".
  const statsError = referralsError || creditsError || codeError;

  const referralColumns: ResponsiveColumn<Referral>[] = [
    {
      key: "user",
      header: "User",
      primary: true,
      cell: (ref) => ref.referredUser.name,
    },
    {
      key: "status",
      header: "Status",
      cell: (ref) => <StatusBadge {...referralStatusBadge(ref.status)} />,
    },
    {
      key: "signedUp",
      header: "Signed Up",
      cell: (ref) => (
        <span className="text-zinc-500">{formatDate(ref.signedUpAt)}</span>
      ),
    },
    {
      key: "reward",
      header: "Reward",
      headClassName: "text-right",
      className: "text-right",
      cell: (ref) =>
        REWARDED_STATUSES.has(ref.status)
          ? formatAmount(ref.referrerRewardAmount)
          : "-",
    },
  ];

  const creditColumns: ResponsiveColumn<CreditData["history"][number]>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (credit) => creditSourceLabel(credit.source),
    },
    {
      key: "state",
      header: "Status",
      cell: (credit) => {
        const state = resolveCreditRowState(credit);
        const badge = creditStateBadge(state);
        return (
          <div className="space-y-0.5">
            <StatusBadge label={badge.label} tone={badge.tone} size="sm" />
            {state === "PENDING" && (
              <p className="text-[11px] text-zinc-500">
                In post-session hold window — not yet spendable
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: "amount",
      header: "Amount",
      cell: (credit) => formatAmount(credit.amount),
    },
    {
      key: "remaining",
      header: "Remaining",
      cell: (credit) => formatAmount(credit.remainingAmount),
    },
    {
      key: "expires",
      header: "Expires",
      cell: (credit) => (
        <span className="text-zinc-500">
          {credit.expiresAt ? formatDate(credit.expiresAt) : "Never"}
        </span>
      ),
    },
  ];

  const weekVests = code?.weekVests ?? 0;
  const weeklyVestCap = code?.weeklyVestCap ?? 3;

  return (
    <>
      <DashboardHeader
        title="Invite & earn"
        subtitle={
          isConsultant
            ? "Invite learners for booking credit, or other experts for fee-free sessions"
            : "Invite friends and earn credit towards your next booking"
        }
      />
      <DashboardContent>
        {statsLoading && !code && !referralsData ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
            <StatCard
              title="Total Referred"
              value={statsError ? "—" : totalReferred}
              icon={Users}
            />
            <StatCard
              title="Qualified"
              value={statsError ? "—" : qualified}
              icon={Gift}
              variant="success"
              tooltip={
                terms
                  ? `Friends who made their first paid booking within ${terms.qualifyWindowDays} days of signing up`
                  : "Friends who made their first paid booking after signing up"
              }
            />
            {isConsultant && (
              <StatCard
                title="Total Earned"
                value={formatAmount(code?.totalEarned ?? 0)}
                icon={IndianRupee}
              />
            )}
            <StatCard
              title="Credit Balance"
              value={formatAmount(credits?.totalAvailable ?? 0)}
              icon={IndianRupee}
              variant="info"
              tooltip={balanceTooltip}
            />
          </DashboardGrid>
        )}

        {isConsultant && feeWaivers.length > 0 && (
          <div
            data-testid="consultant-fee-waivers"
            className="mt-6 rounded-xl border border-zinc-200 bg-white p-6"
          >
            <h3 className="text-sm font-medium text-zinc-900 mb-3">
              Active Platform Fee Waivers
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {feeWaivers.map((waiver) => (
                <div
                  key={waiver.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-emerald-950">
                      {waiver.sessionsRemaining} / {waiver.sessionsGranted}{" "}
                      fee-free sessions remaining
                    </p>
                    <p className="text-xs text-emerald-800">
                      Expires {formatDate(waiver.expiresAt)}
                    </p>
                  </div>
                  <StatusBadge label="Active waiver" tone="success" size="sm" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Referral Link */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-sm font-medium text-zinc-900 mb-3">
            Your Referral Link
          </h3>
          {codeError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't generate your referral link"
              description="Something went wrong while creating your link. Retry, or come back later."
              action={
                <Button variant="outline" onClick={() => refetchCode()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <>
              {code && (
                <>
                  <div className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
                    {terms ? (
                      <>
                        Your friend gets {friendOffer}. You get{" "}
                        {formatAmount(terms.referrerRewardPaise)} credit after
                        your friend&apos;s first session, once its refund window
                        has passed.
                      </>
                    ) : (
                      "The referral programme is paused right now. Friends who sign up while it is paused get no welcome discount and earn you nothing; rewards for new sign-ups resume when it reopens."
                    )}
                    {isConsultant && terms && (
                      <span className="mt-1 block">
                        Refer another expert and you both pay no platform fee on{" "}
                        {terms.expertWaiverSessions} sessions once they have
                        verified their payout details and delivered their first
                        paid session.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-500">Your code:</span>
                      <span className="font-mono font-semibold text-zinc-900 bg-zinc-100 px-3 py-1 rounded-md">
                        {code.customCode || code.code}
                      </span>
                    </div>
                    <span
                      data-testid="weekly-vest-cap"
                      className="text-xs text-zinc-500"
                    >
                      Weekly vesting cap: {weekVests} / {weeklyVestCap} vested
                      this week
                    </span>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <div className="flex-1 flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-800 select-all truncate">
                  {referralLink || (
                    <span className="text-zinc-400 italic font-sans">
                      {codeLoading ? "Generating link..." : "No link available"}
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  disabled={!referralLink}
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
                {referralLink ? (
                  <Button variant="outline" size="icon" asChild>
                    <a
                      href={whatsappUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Share on WhatsApp"
                    >
                      <WhatsAppIcon className="h-4 w-4" />
                    </a>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="icon"
                    disabled
                    aria-label="Share on WhatsApp"
                  >
                    <WhatsAppIcon className="h-4 w-4" />
                  </Button>
                )}
                {referralLink ? (
                  <Button variant="outline" size="icon" asChild>
                    <a
                      href={emailUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Share via email"
                    >
                      <Mail className="h-4 w-4" />
                    </a>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="icon"
                    disabled
                    aria-label="Share via email"
                  >
                    <Mail className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {isConsultant && (
                <div className="flex gap-2 mt-3">
                  <Input
                    placeholder="Set custom code (e.g. MYNAME)"
                    value={customCode}
                    onChange={(e) => setCustomCode(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    onClick={handleCustomize}
                    disabled={customizeMutation.isPending || !customCode.trim()}
                  >
                    {customizeMutation.isPending ? "Saving…" : "Set"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Referrals List */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-zinc-200">
            <h3 className="text-sm font-medium text-zinc-900">
              Your Referrals
            </h3>
          </div>
          {referralsLoading && !referralsData ? (
            <div className="p-4">
              <DataCardSkeleton />
            </div>
          ) : referralsError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't load your referrals"
              description="Retry, or come back later."
              action={
                <Button variant="outline" onClick={() => refetchReferrals()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <ResponsiveTable
              columns={referralColumns}
              rows={referrals}
              getRowId={(ref) => ref.id}
              className="[&>ul]:p-3"
              empty={
                <EmptyState
                  icon={Users}
                  title="No referrals yet"
                  description="Share your link to get started!"
                />
              }
            />
          )}
        </div>

        <CreditHistory
          error={!!creditsError}
          onRetry={() => void refetchCredits()}
          rows={credits?.history ?? []}
          columns={creditColumns}
        />

        {creditsHref && (
          <p className="mt-6 text-sm text-muted-foreground">
            Your credits and how you used them are in{" "}
            <Link
              href={creditsHref}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Payments › Credits
            </Link>
            .
          </p>
        )}
      </DashboardContent>
    </>
  );
}

function CreditHistory({
  error,
  onRetry,
  rows,
  columns,
}: Readonly<{
  error: boolean;
  onRetry: () => void;
  rows: CreditData["history"];
  columns: ResponsiveColumn<CreditData["history"][number]>[];
}>) {
  if (!error && rows.length === 0) return null;
  return (
    <div className="mt-6 bg-white rounded-xl border border-zinc-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-zinc-200">
        <h3 className="text-sm font-medium text-zinc-900">Credit History</h3>
      </div>
      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load your credits"
          description="Retry, or come back later."
          action={
            <Button variant="outline" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : (
        <ResponsiveTable
          columns={columns}
          rows={rows}
          getRowId={(credit) => credit.id}
          className="[&>ul]:p-3"
        />
      )}
    </div>
  );
}
