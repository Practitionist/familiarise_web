"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  RefreshCw,
  Loader2,
  BarChart3,
  Ticket,
  Users,
  Clock,
  CheckCircle,
  UserPlus,
  Activity,
  Calendar,
  TrendingUp,
  Info,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface StaffMetrics {
  supportMetrics: {
    ticketsResolvedToday: number;
    ticketsResolvedThisWeek: number;
    ticketsResolvedThisMonth: number;
    openTickets: number;
    avgResponseTimeHours: number;
  };
  userMetrics: {
    usersHelpedThisWeek: number;
    activeUsers: number;
    newSignupsThisMonth: number;
    totalUsers: number;
  };
  platformMetrics: {
    totalAppointments: number;
    pendingPayments: number;
  };
}

export default function StaffMetricsPage() {
  const { toast } = useToast();
  const [metrics, setMetrics] = useState<StaffMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/staff/metrics");
      if (!response.ok) throw new Error("Failed to fetch metrics");

      const data = await response.json();
      setMetrics(data);
    } catch (error) {
      console.error("Error fetching metrics:", error);
      toast({
        title: "Error",
        description: "Failed to load metrics",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Metrics
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Operational metrics and insights
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center h-64 text-zinc-500">
            <BarChart3 className="h-12 w-12 mb-4 text-zinc-300" />
            <p>Unable to load metrics</p>
            <Button variant="outline" onClick={fetchMetrics} className="mt-4">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Metrics
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Operational metrics and insights
          </p>
        </div>
        <Button variant="outline" onClick={fetchMetrics} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Staff Access Notice */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Staff Metrics View</AlertTitle>
        <AlertDescription>
          This dashboard shows operational metrics relevant to staff activities.
          Revenue and financial data are available in the admin dashboard.
        </AlertDescription>
      </Alert>

      {/* Support Performance */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Ticket className="h-5 w-5 text-blue-600" />
          Support Performance
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Resolved Today</p>
                  <p className="text-3xl font-bold text-green-600">
                    {metrics.supportMetrics.ticketsResolvedToday}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-green-50 dark:bg-green-950">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Resolved This Week</p>
                  <p className="text-3xl font-bold text-blue-600">
                    {metrics.supportMetrics.ticketsResolvedThisWeek}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-blue-50 dark:bg-blue-950">
                  <TrendingUp className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Open Tickets</p>
                  <p
                    className={`text-3xl font-bold ${metrics.supportMetrics.openTickets > 10 ? "text-red-600" : "text-yellow-600"}`}
                  >
                    {metrics.supportMetrics.openTickets}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-full ${metrics.supportMetrics.openTickets > 10 ? "bg-red-50 dark:bg-red-950" : "bg-yellow-50 dark:bg-yellow-950"}`}
                >
                  <Ticket
                    className={`h-6 w-6 ${metrics.supportMetrics.openTickets > 10 ? "text-red-600" : "text-yellow-600"}`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Avg Response Time</p>
                  <p className="text-3xl font-bold text-purple-600">
                    {metrics.supportMetrics.avgResponseTimeHours}h
                  </p>
                </div>
                <div className="p-3 rounded-full bg-purple-50 dark:bg-purple-950">
                  <Clock className="h-6 w-6 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* User Metrics */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-600" />
          User Metrics
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">
                    Users Helped This Week
                  </p>
                  <p className="text-3xl font-bold text-indigo-600">
                    {metrics.userMetrics.usersHelpedThisWeek}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950">
                  <Users className="h-6 w-6 text-indigo-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Active Users</p>
                  <p className="text-3xl font-bold text-emerald-600">
                    {metrics.userMetrics.activeUsers}
                  </p>
                  <p className="text-xs text-zinc-400">This month</p>
                </div>
                <div className="p-3 rounded-full bg-emerald-50 dark:bg-emerald-950">
                  <Activity className="h-6 w-6 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">New Signups</p>
                  <p className="text-3xl font-bold text-cyan-600">
                    {metrics.userMetrics.newSignupsThisMonth}
                  </p>
                  <p className="text-xs text-zinc-400">This month</p>
                </div>
                <div className="p-3 rounded-full bg-cyan-50 dark:bg-cyan-950">
                  <UserPlus className="h-6 w-6 text-cyan-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-blue-600">Total Users</p>
                  <p className="text-3xl font-bold text-blue-700">
                    {metrics.userMetrics.totalUsers.toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900">
                  <Users className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Platform Health */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Calendar className="h-5 w-5 text-amber-600" />
          Platform Activity
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Total Appointments</p>
                  <p className="text-3xl font-bold text-amber-600">
                    {metrics.platformMetrics.totalAppointments.toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-amber-50 dark:bg-amber-950">
                  <Calendar className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Pending Payments</p>
                  <p
                    className={`text-3xl font-bold ${metrics.platformMetrics.pendingPayments > 20 ? "text-orange-600" : "text-teal-600"}`}
                  >
                    {metrics.platformMetrics.pendingPayments}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-full ${metrics.platformMetrics.pendingPayments > 20 ? "bg-orange-50 dark:bg-orange-950" : "bg-teal-50 dark:bg-teal-950"}`}
                >
                  <Clock
                    className={`h-6 w-6 ${metrics.platformMetrics.pendingPayments > 20 ? "text-orange-600" : "text-teal-600"}`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-500">Monthly Resolved</p>
                  <p className="text-3xl font-bold text-rose-600">
                    {metrics.supportMetrics.ticketsResolvedThisMonth}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-rose-50 dark:bg-rose-950">
                  <BarChart3 className="h-6 w-6 text-rose-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
