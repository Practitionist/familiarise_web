"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ClipboardCheck,
  Loader,
  CheckCircle,
  Wallet,
  ArrowRight,
} from "lucide-react";

interface PayoutStatCategory {
  count: number;
  amount: number;
}

interface PayoutStatsResponse {
  payouts: unknown[];
  stats: {
    pending: PayoutStatCategory;
    approved: PayoutStatCategory;
    processing: PayoutStatCategory;
    completed: PayoutStatCategory;
    failed: PayoutStatCategory;
  };
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchPayoutStats(): Promise<PayoutStatsResponse> {
  const response = await fetch("/api/admin/payouts?limit=0");
  if (!response.ok) {
    throw new Error("Failed to fetch payout stats");
  }
  return response.json() as Promise<PayoutStatsResponse>;
}

export default function AdminPayoutsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payout-stats"],
    queryFn: fetchPayoutStats,
    staleTime: 30 * 1000,
  });

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error ? error.message : "Failed to load stats"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const stats = data?.stats || {
    pending: { count: 0, amount: 0 },
    approved: { count: 0, amount: 0 },
    processing: { count: 0, amount: 0 },
    completed: { count: 0, amount: 0 },
  };

  const sections = [
    {
      title: "Pending Approval",
      description: "Payouts awaiting admin approval",
      path: "/dashboard/admin/payouts/pending",
      icon: ClipboardCheck,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
      count: stats.pending?.count || 0,
      amount: stats.pending?.amount || 0,
    },
    {
      title: "Processing",
      description: "Payouts being processed by payment providers",
      path: "/dashboard/admin/payouts/processing",
      icon: Loader,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
      count: stats.processing?.count || 0,
      amount: stats.processing?.amount || 0,
    },
    {
      title: "Completed",
      description: "Successfully completed payouts",
      path: "/dashboard/admin/payouts/completed",
      icon: CheckCircle,
      color: "text-green-600",
      bgColor: "bg-green-50",
      count: stats.completed?.count || 0,
      amount: stats.completed?.amount || 0,
    },
    {
      title: "Consultant Earnings",
      description: "View and manage consultant earnings",
      path: "/dashboard/admin/payouts/earnings",
      icon: Wallet,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
      count: null,
      amount: null,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Payouts</h1>
        <p className="text-gray-600 mt-1">
          Manage consultant payouts and earnings
        </p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {isLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </>
        ) : (
          sections.map((section) => (
            <Link key={section.path} href={section.path}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-500">{section.title}</p>
                      {section.count !== null ? (
                        <>
                          <p className="text-2xl font-bold text-gray-900">
                            {section.count}
                          </p>
                          <p className="text-sm text-gray-500">
                            {(section.amount / 100).toLocaleString("en-IN", {
                              style: "currency",
                              currency: "INR",
                            })}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-gray-500 mt-2">
                          View details
                        </p>
                      )}
                    </div>
                    <div className={`p-3 rounded-full ${section.bgColor}`}>
                      <section.icon className={`w-6 h-6 ${section.color}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))
        )}
      </div>

      {/* Section Links */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sections.map((section) => (
          <Link key={section.path} href={section.path}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-lg ${section.bgColor}`}>
                    <section.icon className={`w-6 h-6 ${section.color}`} />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900">
                      {section.title}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {section.description}
                    </p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-gray-400" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
