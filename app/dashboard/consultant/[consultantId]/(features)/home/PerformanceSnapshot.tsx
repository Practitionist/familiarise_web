"use client";

import { StatCard } from "@/components/dashboard/StatCard";
import { DollarSign, CheckCircle, Star, TrendingUp } from "lucide-react";
import type { TPerformanceSnapshot } from "@/types/consultant-events";

type PerformanceSnapshotProps = TPerformanceSnapshot;

export function PerformanceSnapshot({
  earningsThisMonth,
  earningsTrend,
  completionRate,
  averageRating,
  totalReviews,
  trialConversionRate,
}: PerformanceSnapshotProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title="Earnings This Month"
        value={`\u20B9${(earningsThisMonth / 100).toLocaleString("en-IN")}`}
        icon={DollarSign}
        trend={
          earningsTrend !== 0
            ? {
                value: Math.abs(earningsTrend),
                isPositive: earningsTrend > 0,
              }
            : undefined
        }
        tooltip="Compared to last month"
      />
      <StatCard
        title="Completion Rate"
        value={`${completionRate}%`}
        icon={CheckCircle}
        variant={
          completionRate >= 90
            ? "success"
            : completionRate >= 70
              ? "warning"
              : "danger"
        }
        tooltip="Sessions completed vs cancelled (last 30 days)"
      />
      <StatCard
        title="Average Rating"
        value={averageRating > 0 ? averageRating.toFixed(1) : "N/A"}
        subtitle={
          totalReviews > 0
            ? `${totalReviews} review${totalReviews !== 1 ? "s" : ""}`
            : "No reviews yet"
        }
        icon={Star}
        variant={
          averageRating >= 4
            ? "success"
            : averageRating >= 3
              ? "warning"
              : "default"
        }
      />
      <StatCard
        title="Trial Conversions"
        value={`${trialConversionRate}%`}
        icon={TrendingUp}
        variant={
          trialConversionRate >= 50
            ? "success"
            : trialConversionRate >= 25
              ? "warning"
              : "default"
        }
        tooltip="Trials that converted to paid subscriptions"
      />
    </div>
  );
}
