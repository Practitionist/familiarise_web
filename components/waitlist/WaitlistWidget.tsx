"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Users, Loader2 } from "lucide-react";

interface WaitlistStats {
  totalWaiting: number;
  byWebinar: Array<{ webinarId: string; title: string; waitingCount: number }>;
  byClass: Array<{ classId: string; title: string; waitingCount: number }>;
  averageWaitTimeDays: number;
}

interface WaitlistWidgetProps {
  className?: string;
}

export function WaitlistWidget({ className }: WaitlistWidgetProps) {
  const [stats, setStats] = useState<WaitlistStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch("/api/waitlist/stats");
        const result = await response.json();

        if (result.success) {
          setStats(result.data);
        } else {
          setError(result.error || "Failed to load stats");
        }
      } catch {
        setError("Failed to load waitlist stats");
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !stats) {
    return null; // Hide widget if there's an error or no data
  }

  const totalEvents = stats.byWebinar.length + stats.byClass.length;

  return (
    <Card className={className}>
      <CardContent className="p-6">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
            <Users className="h-6 w-6 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 text-sm">Waitlist</h3>
            <p className="text-2xl font-bold text-gray-900">
              {stats.totalWaiting}
            </p>
            <p className="text-xs text-gray-500 truncate">
              {totalEvents > 0
                ? `across ${totalEvents} event${totalEvents > 1 ? "s" : ""}`
                : "No active waitlists"}
            </p>
          </div>
        </div>

        {stats.totalWaiting > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="space-y-2">
              {stats.byWebinar.slice(0, 2).map((item) => (
                <div
                  key={item.webinarId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-600 truncate flex-1 mr-2">
                    {item.title}
                  </span>
                  <span className="font-medium text-amber-600 shrink-0">
                    {item.waitingCount} waiting
                  </span>
                </div>
              ))}
              {stats.byClass.slice(0, 2).map((item) => (
                <div
                  key={item.classId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-600 truncate flex-1 mr-2">
                    {item.title}
                  </span>
                  <span className="font-medium text-amber-600 shrink-0">
                    {item.waitingCount} waiting
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default WaitlistWidget;
