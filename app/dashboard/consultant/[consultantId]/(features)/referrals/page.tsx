"use client";

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { Users, Gift, IndianRupee, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    } else {
      toast({ title: "Failed to set custom code", variant: "destructive" });
    }
  };

  const formatAmount = (paise: number) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
    }).format(paise / 100);

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
          />
        </DashboardGrid>

        {/* Referral Link */}
        <div className="mt-6 bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-sm font-medium text-zinc-900 mb-3">
            Your Referral Link
          </h3>
          <div className="flex gap-2">
            <Input value={referralLink} readOnly className="flex-1" />
            <Button variant="outline" onClick={handleCopy}>
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
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
                  <th className="px-6 py-3 text-left font-medium">
                    Signed Up
                  </th>
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
                  <th className="px-6 py-3 text-left font-medium">
                    Remaining
                  </th>
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
                    <td className="px-6 py-3">
                      {formatAmount(credit.amount)}
                    </td>
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
