"use client";

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { Users, Gift, IndianRupee, Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useToast } from "@/hooks/use-toast";
import { WhatsAppIcon } from "@/components/icons/WhatsAppIcon";
import { QUALIFICATION_WINDOW_DAYS } from "@/lib/referrals/constants";
import { useCurrency } from "@/hooks/useCurrency";
import { StatCardSkeleton } from "@/components/dashboard/StatCard";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { referralStatusBadge } from "@/lib/labels/session-labels";

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
}

interface Referral {
  id: string;
  status: string;
  signedUpAt: string;
  qualifiedAt: string | null;
  referrerRewardAmount: number;
  refereeRewardAmount: number;
  referredUser: { name: string; image: string | null };
}

interface CreditData {
  totalAvailable: number;
  history: {
    id: string;
    amount: number;
    remainingAmount: number;
    source: string;
    createdAt: string;
    expiresAt: string | null;
  }[];
}

export default function ConsulteeReferralsPage({
  params,
}: {
  params: Promise<{ consulteeId: string }>;
}) {
  use(params);
  const { toast } = useToast();
  const { formatPrice } = useCurrency();
  const [copied, setCopied] = useState(false);

  const {
    data: codeData,
    isLoading: codeLoading,
    isError: codeError,
    refetch: refetchCode,
  } = useQuery<{ data: ReferralCode }>({
    queryKey: ["referral-code"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/code", { method: "POST" });
      if (!res.ok) throw new Error("Failed to fetch referral code");
      return res.json();
    },
    staleTime: 60_000,
  });

  const {
    data: referralsData,
    isLoading: referralsLoading,
    isError: referralsError,
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

  const isLoading = codeLoading || referralsLoading || creditsLoading;

  const code = codeData?.data;
  const referrals = referralsData?.data ?? [];
  const credits = creditsData?.data;
  const referralLink = code
    ? `${window.location.origin}/r/${code.customCode || code.code}`
    : "";

  const shareMessage = referralLink
    ? `Hey! I've been using Familiarise and it's been great. Use my referral link to get ${formatPrice(code?.refereeReward ?? 0)} off your first booking: ${referralLink}`
    : "";
  const whatsappUrl = referralLink
    ? `https://wa.me/?text=${encodeURIComponent(shareMessage)}`
    : "";
  const emailUrl = referralLink
    ? `mailto:?subject=${encodeURIComponent(`Get ${formatPrice(code?.refereeReward ?? 0)} off your first booking on Familiarise`)}&body=${encodeURIComponent(shareMessage)}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast({ title: "Referral link copied!" });
    setTimeout(() => setCopied(false), 2000);
  };

  // formatPrice from useCurrency handles paise→display conversion with currency preference

  // Semantic status pills kept (green=rewarded, yellow=signed up); other
  // statuses fall back to neutral monochrome.
  const referralColumns: ResponsiveColumn<Referral>[] = [
    {
      key: "user",
      header: "User",
      primary: true,
      cell: (ref) => (
        <span className="text-foreground">{ref.referredUser.name}</span>
      ),
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
        <span className="text-muted-foreground">
          {new Date(ref.signedUpAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "reward",
      header: "Reward",
      headClassName: "text-right",
      className: "text-right",
      cell: (ref) =>
        ref.status === "REWARDED"
          ? formatPrice(ref.referrerRewardAmount)
          : "-",
    },
  ];

  const creditHistoryColumns: ResponsiveColumn<CreditData["history"][number]>[] =
    [
      {
        key: "source",
        header: "Source",
        primary: true,
        cell: (credit) => (
          <span className="text-foreground">
            {credit.source.replace(/_/g, " ")}
          </span>
        ),
      },
      {
        key: "amount",
        header: "Amount",
        cell: (credit) => formatPrice(credit.amount),
      },
      {
        key: "remaining",
        header: "Remaining",
        cell: (credit) => formatPrice(credit.remainingAmount),
      },
      {
        key: "expires",
        header: "Expires",
        cell: (credit) => (
          <span className="text-muted-foreground">
            {credit.expiresAt
              ? new Date(credit.expiresAt).toLocaleDateString()
              : "Never"}
          </span>
        ),
      },
    ];

  if (isLoading) {
    return (
      <>
        <DashboardHeader
          title="Referrals"
          subtitle="Invite friends and earn credits towards your next booking"
        />
        <DashboardContent>
          <DashboardGrid columns={3}>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </DashboardGrid>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="Referrals"
        subtitle="Invite friends and earn credits towards your next booking"
      />
      <DashboardContent>
        <DashboardGrid columns={3}>
          <StatCard
            title="Total Referred"
            value={code?.totalReferrals ?? 0}
            icon={Users}
          />
          <StatCard
            title="Qualified"
            value={code?.successfulReferrals ?? 0}
            icon={Gift}
            variant="success"
            tooltip={`Friends who signed up and completed their first paid booking within ${QUALIFICATION_WINDOW_DAYS} days`}
          />
          <StatCard
            title="Credit Balance"
            value={formatPrice(credits?.totalAvailable ?? 0)}
            icon={IndianRupee}
            variant="info"
            tooltip="Credits earned from referrals. Applied at checkout."
          />
        </DashboardGrid>

        {/* Referral Link */}
        <div className="mt-6 bg-card rounded-xl border border-border p-6">
          <h3 className="text-sm font-medium text-foreground mb-3">
            Your Referral Link
          </h3>
          {code && (
            <div className="mb-3 rounded-lg bg-muted border border-border px-4 py-3 text-sm text-muted-foreground">
              Earn {formatPrice(code.referrerReward)} for each friend who
              books. Your friend gets {formatPrice(code.refereeReward)} off
              their first booking!
            </div>
          )}
          {codeError && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
              <span>Couldn&apos;t generate your referral link.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchCode()}
              >
                Retry
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <div className="min-w-0 flex-1 flex items-center rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground select-all truncate">
              {referralLink || (
                <span className="text-muted-foreground/70 italic font-sans">
                  {codeError ? "Link unavailable" : "Generating link..."}
                </span>
              )}
            </div>
            <Button variant="outline" size="icon" onClick={handleCopy}>
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              asChild
              disabled={!referralLink}
            >
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Share on WhatsApp"
              >
                <WhatsAppIcon className="h-4 w-4" />
              </a>
            </Button>
            <Button
              variant="outline"
              size="icon"
              asChild
              disabled={!referralLink}
            >
              <a
                href={emailUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Share via email"
              >
                <Mail className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>

        {/* Referrals List */}
        <div className="mt-6 bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="text-sm font-medium text-foreground">
              Your Referrals
            </h3>
          </div>
          <div className="p-2 sm:p-3">
            {referralsError ? (
              <EmptyState
                icon={Users}
                title="Couldn't load referrals"
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      void refetchReferrals();
                      void refetchCredits();
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            ) : (
              <ResponsiveTable<Referral>
                columns={referralColumns}
                rows={referrals}
                getRowId={(r) => r.id}
                empty={
                  <div className="px-6 py-12 text-center text-muted-foreground text-sm">
                    No referrals yet. Share your link to get started!
                  </div>
                }
              />
            )}
          </div>
        </div>

        {/* Credit History */}
        {credits?.history && credits.history.length > 0 && (
          <div className="mt-6 bg-card rounded-xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h3 className="text-sm font-medium text-foreground">
                Credit History
              </h3>
            </div>
            <div className="p-2 sm:p-3">
              <ResponsiveTable<CreditData["history"][number]>
                columns={creditHistoryColumns}
                rows={credits.history}
                getRowId={(c) => c.id}
              />
            </div>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
