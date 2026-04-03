"use client";

import { use, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { Users, Gift, IndianRupee, Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { WhatsAppIcon } from "@/components/icons/WhatsAppIcon";
import {
  QUALIFICATION_WINDOW_DAYS,
  CREDIT_EXPIRY_MONTHS,
} from "@/lib/referrals/constants";

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

export default function ConsultantReferralsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  use(params);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [customCode, setCustomCode] = useState("");

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

  const handleCustomize = async () => {
    if (!customCode.trim()) return;
    const res = await fetch("/api/referrals/code/customize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customCode }),
    });
    if (res.ok) {
      toast({ title: "Custom code set!" });
      setCustomCode("");
      queryClient.invalidateQueries({ queryKey: ["referral-code"] });
    } else {
      toast({ title: "Failed to set custom code", variant: "destructive" });
    }
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
        subtitle="Invite others and earn credits when they make their first booking"
      />
      <DashboardContent>
        <DashboardGrid columns={4}>
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
            title="Total Earned"
            value={formatAmount(code?.totalEarned ?? 0)}
            icon={IndianRupee}
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
          <div className="flex gap-2 mt-3">
            <Input
              placeholder="Set custom code (e.g. MYNAME)"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              className="flex-1"
            />
            <Button variant="outline" onClick={handleCustomize}>
              Set
            </Button>
          </div>
        </div>

        {/* TODO: Program Details - hidden for now
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-sm font-medium text-zinc-900 mb-3">
            Program Details
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Qualification Window</p>
              <p className="mt-1 font-medium text-zinc-900">{QUALIFICATION_WINDOW_DAYS} days</p>
            </div>
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Credit Expiry</p>
              <p className="mt-1 font-medium text-zinc-900">{CREDIT_EXPIRY_MONTHS} months</p>
            </div>
            <div className="rounded-lg bg-zinc-50 px-4 py-3">
              <p className="text-zinc-500">Max Referrals</p>
              <p className="mt-1 font-medium text-zinc-900">
                {code?.maxReferrals ?? 50}
              </p>
            </div>
          </div>
        </div>
        */}

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
