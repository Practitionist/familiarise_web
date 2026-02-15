"use client";

import { BarChart3 } from "lucide-react";

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Analytics</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Track your performance and insights.
        </p>
      </div>

      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white p-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 mb-4">
          <BarChart3 className="h-7 w-7 text-zinc-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900">Coming Soon</h2>
        <p className="mt-2 max-w-sm text-sm text-zinc-500">
          Analytics and insights for your consultations, earnings, and audience
          engagement will be available here.
        </p>
      </div>
    </div>
  );
}
