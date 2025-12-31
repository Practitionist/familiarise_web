"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";

async function fetchAnalytics() {
  const response = await fetch("/api/admin/analytics");
  if (!response.ok) {
    throw new Error("Failed to fetch analytics");
  }
  return response.json();
}

export default function AdminAnalyticsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: fetchAnalytics,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-[100px]" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[60px]" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-red-500">
              Failed to load analytics. Please try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
        <p className="text-gray-600 mt-1">Platform usage and growth metrics</p>
      </div>

      {/* User Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Total Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">
              {data?.totalUsers || 0}
            </div>
            <p className="text-xs text-green-600 mt-1">
              +{data?.newUsersThisMonth || 0} this month
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Consultants
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {data?.totalConsultants || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {data?.activeConsultants || 0} active
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Consultees
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {data?.totalConsultees || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {data?.activeConsultees || 0} active
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Staff Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-600">
              {data?.totalStaff || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Session Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sessions Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Total Sessions</span>
                <span className="font-bold">{data?.totalSessions || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Completed Sessions</span>
                <span className="font-bold text-green-600">
                  {data?.completedSessions || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Upcoming Sessions</span>
                <span className="font-bold text-blue-600">
                  {data?.upcomingSessions || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Cancelled Sessions</span>
                <span className="font-bold text-red-600">
                  {data?.cancelledSessions || 0}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Revenue Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Total Revenue</span>
                <span className="font-bold">
                  ${(data?.totalRevenue || 0).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">This Month</span>
                <span className="font-bold text-green-600">
                  ${(data?.revenueThisMonth || 0).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Average Session Value</span>
                <span className="font-bold">
                  ${(data?.avgSessionValue || 0).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600">Refunds</span>
                <span className="font-bold text-red-600">
                  ${(data?.totalRefunds || 0).toLocaleString()}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top Domains */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top Consulting Domains</CardTitle>
        </CardHeader>
        <CardContent>
          {data?.topDomains?.length > 0 ? (
            <div className="space-y-3">
              {data.topDomains.map(
                (
                  domain: { name: string; consultantCount: number },
                  index: number,
                ) => (
                  <div
                    key={domain.name}
                    className="flex items-center justify-between p-3 border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 text-sm w-6">
                        #{index + 1}
                      </span>
                      <span className="font-medium">{domain.name}</span>
                    </div>
                    <span className="text-gray-600">
                      {domain.consultantCount} consultants
                    </span>
                  </div>
                ),
              )}
            </div>
          ) : (
            <p className="text-gray-500 text-center py-4">
              No domain data available
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
