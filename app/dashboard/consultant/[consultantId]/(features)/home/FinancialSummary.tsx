"use client";

import { DataCard } from "@/components/dashboard/DataCard";
import { DollarSign, Wallet, Users, Layers } from "lucide-react";
import type { TFinancialSummary } from "@/types/consultant-events";
import { formatCurrencyAmount } from "@/utils/formatting";

type FinancialSummaryProps = TFinancialSummary;

export function FinancialSummary({
  netEarnings,
  nextPayout,
  payoutStatus,
  activeClients,
  activePrograms,
}: FinancialSummaryProps) {
  const formatCurrency = (paise: number) => formatCurrencyAmount(paise, "INR");

  const items = [
    {
      icon: DollarSign,
      label: "Net Earnings",
      value: formatCurrency(netEarnings),
    },
    {
      icon: Wallet,
      label: "Next Payout",
      value: formatCurrency(nextPayout),
      subtitle: payoutStatus,
    },
    {
      icon: Users,
      label: "Active Clients",
      value: String(activeClients),
    },
    {
      icon: Layers,
      label: "Active Programs",
      value: String(activePrograms),
    },
  ];

  return (
    <DataCard title="Financial Summary" icon={DollarSign}>
      <div className="space-y-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center justify-between py-2"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-zinc-100 flex items-center justify-center">
                <item.icon className="h-4 w-4 text-zinc-600" />
              </div>
              <div>
                <p className="text-sm text-zinc-500">{item.label}</p>
                {item.subtitle && (
                  <p className="text-xs text-zinc-400">{item.subtitle}</p>
                )}
              </div>
            </div>
            <p className="text-sm font-semibold text-zinc-900">{item.value}</p>
          </div>
        ))}
      </div>
    </DataCard>
  );
}
