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
import { useToast } from "@/hooks/use-toast";

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
  const [copied, setCopied] = useState(false);

  const { data: codeData } = useQuery<{ data: ReferralCode }>({
    queryKey: ["referral-code"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/code", { method: "POST" });
      if (!res.ok) throw new Error("Failed to fetch referral code");
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: referralsData } = useQuery<{ data: Referral[] }>({
    queryKey: ["referrals"],
    queryFn: async () => {
      const res = await fetch("/api/referrals");
      if (!res.ok) throw new Error("Failed to fetch referrals");
      return res.json();
    },
    staleTime: 30_000,
  });

  const { data: creditsData } = useQuery<{ data: CreditData }>({
    queryKey: ["referral-credits"],
    queryFn: async () => {
      const res = await fetch("/api/referrals/credits");
      if (!res.ok) throw new Error("Failed to fetch credits");
      return res.json();
    },
    staleTime: 30_000,
  });

  const code = codeData?.data;
  const referrals = referralsData?.data ?? [];
  const credits = creditsData?.data;
  const referralLink = code
    ? `${window.location.origin}/r/${code.customCode || code.code}`
    : "";

  const shareMessage = referralLink
    ? `Hey! I've been using Familiarise and it's been great. Use my referral link to get ${formatAmount(code?.refereeReward ?? 0)} off your first booking: ${referralLink}`
    : "";
  const whatsappUrl = referralLink
    ? `https://wa.me/?text=${encodeURIComponent(shareMessage)}`
    : "";
  const emailUrl = referralLink
    ? `mailto:?subject=${encodeURIComponent(`Get ${formatAmount(code?.refereeReward ?? 0)} off your first booking on Familiarise`)}&body=${encodeURIComponent(shareMessage)}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast({ title: "Referral link copied!" });
    setTimeout(() => setCopied(false), 2000);
  };

  function formatAmount(paise: number) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
    }).format(paise / 100);
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
            tooltip="Friends who signed up and completed their first paid booking within 30 days"
          />
          <StatCard
            title="Credit Balance"
            value={formatAmount(credits?.totalAvailable ?? 0)}
            icon={IndianRupee}
            variant="info"
            tooltip="Credits earned from referrals. Applied at checkout."
          />
        </DashboardGrid>

        {/* Referral Link */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-sm font-medium text-zinc-900 mb-3">
            Your Referral Link
          </h3>
          {code && (
            <div className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
              Earn {formatAmount(code.referrerReward)} for each friend who
              books. Your friend gets {formatAmount(code.refereeReward)} off
              their first booking!
            </div>
          )}
          <div className="flex gap-2">
            <div className="flex-1 flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-800 select-all truncate">
              {referralLink || (
                <span className="text-zinc-400 italic font-sans">
                  Generating link...
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
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-4 w-4"
                >
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                </svg>
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

        {/* Program Details */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-sm font-medium text-zinc-900 mb-3">
            Program Details
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Qualification Window</p>
              <p className="mt-1 font-medium text-zinc-900">30 days</p>
            </div>
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Credit Expiry</p>
              <p className="mt-1 font-medium text-zinc-900">6 months</p>
            </div>
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Max Referrals</p>
              <p className="mt-1 font-medium text-zinc-900">
                {code?.maxReferrals ?? 50}
              </p>
            </div>
          </div>
        </div>

        {/* Referrals List */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-zinc-200">
            <h3 className="text-sm font-medium text-zinc-900">
              Your Referrals
            </h3>
          </div>
          {referrals.length === 0 ? (
            <div className="px-6 py-12 text-center text-zinc-500 text-sm">
              No referrals yet. Share your link to get started!
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-zinc-500">
                  <th className="px-6 py-3 text-left font-medium">User</th>
                  <th className="px-6 py-3 text-left font-medium">Status</th>
                  <th className="px-6 py-3 text-left font-medium">Signed Up</th>
                  <th className="px-6 py-3 text-right font-medium">Reward</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((ref) => (
                  <tr
                    key={ref.id}
                    className="border-b border-zinc-50 last:border-0"
                  >
                    <td className="px-6 py-3">{ref.referredUser.name}</td>
                    <td className="px-6 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          ref.status === "REWARDED"
                            ? "bg-green-100 text-green-700"
                            : ref.status === "SIGNED_UP"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {ref.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-zinc-500">
                      {new Date(ref.signedUpAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {ref.status === "REWARDED"
                        ? formatAmount(ref.referrerRewardAmount)
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Credit History */}
        {credits?.history && credits.history.length > 0 && (
          <div className="mt-6 bg-white rounded-xl border border-zinc-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-200">
              <h3 className="text-sm font-medium text-zinc-900">
                Credit History
              </h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-zinc-500">
                  <th className="px-6 py-3 text-left font-medium">Source</th>
                  <th className="px-6 py-3 text-left font-medium">Amount</th>
                  <th className="px-6 py-3 text-left font-medium">Remaining</th>
                  <th className="px-6 py-3 text-left font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {credits.history.map((credit) => (
                  <tr
                    key={credit.id}
                    className="border-b border-zinc-50 last:border-0"
                  >
                    <td className="px-6 py-3">
                      {credit.source.replace(/_/g, " ")}
                    </td>
                    <td className="px-6 py-3">{formatAmount(credit.amount)}</td>
                    <td className="px-6 py-3">
                      {formatAmount(credit.remainingAmount)}
                    </td>
                    <td className="px-6 py-3 text-zinc-500">
                      {credit.expiresAt
                        ? new Date(credit.expiresAt).toLocaleDateString()
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
