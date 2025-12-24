"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Users,
  Ticket,
  Clock,
  CheckCircle2,
  Star,
  Calendar,
  Download,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { useState } from "react";

// Mock data for reports
const performanceStats = {
  ticketsResolved: { value: 156, change: 12, trend: "up" },
  avgResolutionTime: { value: "2.5h", change: -15, trend: "down" },
  customerSatisfaction: { value: "94%", change: 3, trend: "up" },
  activeTickets: { value: 24, change: -5, trend: "down" },
};

const weeklyData = [
  { day: "Mon", tickets: 28, resolved: 25 },
  { day: "Tue", tickets: 32, resolved: 30 },
  { day: "Wed", tickets: 24, resolved: 24 },
  { day: "Thu", tickets: 35, resolved: 32 },
  { day: "Fri", tickets: 30, resolved: 28 },
  { day: "Sat", tickets: 15, resolved: 15 },
  { day: "Sun", tickets: 12, resolved: 12 },
];

const categoryBreakdown = [
  { category: "Payment Issues", count: 45, percentage: 29 },
  { category: "Technical Problems", count: 38, percentage: 24 },
  { category: "Account Issues", count: 32, percentage: 20 },
  { category: "Refund Requests", count: 25, percentage: 16 },
  { category: "Other", count: 16, percentage: 10 },
];

const recentActivity = [
  { action: "Resolved ticket #TKT-156", time: "10 minutes ago", type: "success" },
  { action: "Escalated ticket #TKT-155 to admin", time: "25 minutes ago", type: "warning" },
  { action: "Approved refund #REF-042", time: "1 hour ago", type: "success" },
  { action: "Verified profile #PRF-089", time: "2 hours ago", type: "success" },
  { action: "Resolved ticket #TKT-154", time: "3 hours ago", type: "success" },
];

const teamLeaderboard = [
  { name: "Staff Member 1", ticketsResolved: 45, satisfaction: 96 },
  { name: "Staff Member 2", ticketsResolved: 42, satisfaction: 94 },
  { name: "Staff Member 3", ticketsResolved: 38, satisfaction: 92 },
  { name: "Staff Member 4", ticketsResolved: 31, satisfaction: 89 },
];

export default function ReportsAnalyticsPage() {
  const [timeRange, setTimeRange] = useState("7d");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Reports & Analytics
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Track your performance and team metrics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
                <Ticket className="h-5 w-5 text-blue-600" />
              </div>
              <Badge
                variant="secondary"
                className={
                  performanceStats.ticketsResolved.trend === "up"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }
              >
                {performanceStats.ticketsResolved.trend === "up" ? (
                  <ArrowUpRight className="h-3 w-3 mr-1" />
                ) : (
                  <ArrowDownRight className="h-3 w-3 mr-1" />
                )}
                {performanceStats.ticketsResolved.change}%
              </Badge>
            </div>
            <div className="mt-4">
              <p className="text-3xl font-bold">{performanceStats.ticketsResolved.value}</p>
              <p className="text-sm text-zinc-500">Tickets Resolved</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950">
                <Clock className="h-5 w-5 text-emerald-600" />
              </div>
              <Badge
                variant="secondary"
                className={
                  performanceStats.avgResolutionTime.trend === "down"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }
              >
                <ArrowDownRight className="h-3 w-3 mr-1" />
                {Math.abs(performanceStats.avgResolutionTime.change)}%
              </Badge>
            </div>
            <div className="mt-4">
              <p className="text-3xl font-bold">{performanceStats.avgResolutionTime.value}</p>
              <p className="text-sm text-zinc-500">Avg Resolution Time</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
                <Star className="h-5 w-5 text-amber-600" />
              </div>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-700"
              >
                <ArrowUpRight className="h-3 w-3 mr-1" />
                {performanceStats.customerSatisfaction.change}%
              </Badge>
            </div>
            <div className="mt-4">
              <p className="text-3xl font-bold">{performanceStats.customerSatisfaction.value}</p>
              <p className="text-sm text-zinc-500">Customer Satisfaction</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-950">
                <CheckCircle2 className="h-5 w-5 text-purple-600" />
              </div>
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-700"
              >
                <ArrowDownRight className="h-3 w-3 mr-1" />
                {Math.abs(performanceStats.activeTickets.change)}
              </Badge>
            </div>
            <div className="mt-4">
              <p className="text-3xl font-bold">{performanceStats.activeTickets.value}</p>
              <p className="text-sm text-zinc-500">Active Tickets</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Weekly Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Weekly Ticket Volume</CardTitle>
            <CardDescription>Tickets received vs resolved this week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {weeklyData.map((day) => (
                <div key={day.day} className="flex items-center gap-4">
                  <span className="w-10 text-sm font-medium text-zinc-500">{day.day}</span>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full h-4 overflow-hidden">
                      <div
                        className="bg-blue-500 h-full rounded-full"
                        style={{ width: `${(day.tickets / 40) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-sm text-zinc-500">{day.tickets}</span>
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full h-4 overflow-hidden">
                      <div
                        className="bg-green-500 h-full rounded-full"
                        style={{ width: `${(day.resolved / 40) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-sm text-zinc-500">{day.resolved}</span>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-center gap-6 pt-4 border-t">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-blue-500" />
                  <span className="text-sm text-zinc-500">Received</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-green-500" />
                  <span className="text-sm text-zinc-500">Resolved</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Category Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>By Category</CardTitle>
            <CardDescription>Ticket distribution by type</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {categoryBreakdown.map((item) => (
                <div key={item.category} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-600 dark:text-zinc-400">{item.category}</span>
                    <span className="font-medium">{item.count}</span>
                  </div>
                  <div className="h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full"
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Your latest actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentActivity.map((activity, index) => (
                <div key={index} className="flex items-start gap-3">
                  <div
                    className={`p-1 rounded-full mt-0.5 ${
                      activity.type === "success"
                        ? "bg-green-100 text-green-600"
                        : "bg-amber-100 text-amber-600"
                    }`}
                  >
                    <CheckCircle2 className="h-3 w-3" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm">{activity.action}</p>
                    <p className="text-xs text-zinc-400">{activity.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Team Leaderboard */}
        <Card>
          <CardHeader>
            <CardTitle>Team Leaderboard</CardTitle>
            <CardDescription>Top performers this week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {teamLeaderboard.map((member, index) => (
                <div
                  key={member.name}
                  className="flex items-center justify-between p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold ${
                        index === 0
                          ? "bg-yellow-100 text-yellow-700"
                          : index === 1
                          ? "bg-zinc-200 text-zinc-700"
                          : index === 2
                          ? "bg-amber-100 text-amber-700"
                          : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span className="font-medium">{member.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-sm font-medium">{member.ticketsResolved}</p>
                      <p className="text-xs text-zinc-400">resolved</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">{member.satisfaction}%</p>
                      <p className="text-xs text-zinc-400">satisfaction</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

