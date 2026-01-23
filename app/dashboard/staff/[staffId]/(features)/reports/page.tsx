"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Ticket,
  Clock,
  CheckCircle2,
  Star,
  Download,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface OverviewStats {
  ticketsResolved: number;
  ticketsResolvedChange: number;
  avgResolutionTime: string;
  avgResolutionTimeChange: number;
  customerSatisfaction: number;
  customerSatisfactionChange: number;
  activeTickets: number;
  activeTicketsChange: number;
}

interface TicketVolumeData {
  date: string;
  received: number;
  resolved: number;
}

interface CategoryBreakdown {
  category: string;
  count: number;
  percentage: number;
}

interface TeamMember {
  id: string;
  name: string;
  ticketsResolved: number;
  avgResolutionTime: string;
  satisfaction: number;
}

export default function ReportsAnalyticsPage() {
  const [timeRange, setTimeRange] = useState("7d");

  // Data states
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [ticketVolume, setTicketVolume] = useState<TicketVolumeData[]>([]);
  const [categories, setCategories] = useState<CategoryBreakdown[]>([]);
  const [teamLeaderboard, setTeamLeaderboard] = useState<TeamMember[]>([]);

  // Loading states
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [exporting, setExporting] = useState(false);

  const { toast } = useToast();

  // Fetch overview stats
  const fetchOverview = async () => {
    try {
      setLoadingOverview(true);
      const response = await fetch(
        `/api/staff/reports/overview?period=${timeRange}`
      );
      if (!response.ok) throw new Error("Failed to fetch overview");
      const data = await response.json();
      setOverview(data);
    } catch (error) {
      console.error("Error fetching overview:", error);
      toast({
        title: "Error",
        description: "Failed to load overview stats",
        variant: "destructive",
      });
    } finally {
      setLoadingOverview(false);
    }
  };

  // Fetch ticket volume data
  const fetchTicketVolume = async () => {
    try {
      setLoadingTickets(true);
      const response = await fetch(
        `/api/staff/reports/tickets?period=${timeRange}`
      );
      if (!response.ok) throw new Error("Failed to fetch ticket volume");
      const data = await response.json();
      setTicketVolume(data.data || []);
    } catch (error) {
      console.error("Error fetching ticket volume:", error);
      toast({
        title: "Error",
        description: "Failed to load ticket volume data",
        variant: "destructive",
      });
    } finally {
      setLoadingTickets(false);
    }
  };

  // Fetch category breakdown
  const fetchCategories = async () => {
    try {
      setLoadingCategories(true);
      const response = await fetch(
        `/api/staff/reports/categories?period=${timeRange}`
      );
      if (!response.ok) throw new Error("Failed to fetch categories");
      const data = await response.json();
      setCategories(data.categories || []);
    } catch (error) {
      console.error("Error fetching categories:", error);
      toast({
        title: "Error",
        description: "Failed to load category breakdown",
        variant: "destructive",
      });
    } finally {
      setLoadingCategories(false);
    }
  };

  // Fetch team leaderboard
  const fetchTeamLeaderboard = async () => {
    try {
      setLoadingTeam(true);
      const response = await fetch(
        `/api/staff/reports/team?period=${timeRange}&limit=4`
      );
      if (!response.ok) throw new Error("Failed to fetch team leaderboard");
      const data = await response.json();
      setTeamLeaderboard(data.team || []);
    } catch (error) {
      console.error("Error fetching team leaderboard:", error);
      toast({
        title: "Error",
        description: "Failed to load team leaderboard",
        variant: "destructive",
      });
    } finally {
      setLoadingTeam(false);
    }
  };

  // Export report
  const handleExport = async () => {
    try {
      setExporting(true);
      const response = await fetch(
        `/api/staff/reports/export?period=${timeRange}&format=csv`
      );
      if (!response.ok) throw new Error("Failed to export report");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `staff-report-${timeRange}-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export Complete",
        description: "Report has been downloaded successfully",
      });
    } catch (error) {
      console.error("Error exporting report:", error);
      toast({
        title: "Error",
        description: "Failed to export report",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  // Fetch all data when time range changes
  useEffect(() => {
    fetchOverview();
    fetchTicketVolume();
    fetchCategories();
    fetchTeamLeaderboard();
  }, [timeRange]);

  const refreshAll = () => {
    fetchOverview();
    fetchTicketVolume();
    fetchCategories();
    fetchTeamLeaderboard();
  };

  // Format day label for ticket volume
  const formatDayLabel = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { weekday: "short" });
  };

  // Get max value for bar chart scaling
  const maxTickets = Math.max(
    ...ticketVolume.map((d) => Math.max(d.received, d.resolved)),
    1
  );

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
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshAll}
            disabled={loadingOverview}
          >
            <RefreshCw
              className={`h-4 w-4 ${loadingOverview ? "animate-spin" : ""}`}
            />
          </Button>
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
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export
          </Button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-6">
            {loadingOverview ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
                    <Ticket className="h-5 w-5 text-blue-600" />
                  </div>
                  {overview && (
                    <Badge
                      variant="secondary"
                      className={
                        overview.ticketsResolvedChange >= 0
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }
                    >
                      {overview.ticketsResolvedChange >= 0 ? (
                        <ArrowUpRight className="h-3 w-3 mr-1" />
                      ) : (
                        <ArrowDownRight className="h-3 w-3 mr-1" />
                      )}
                      {Math.abs(overview.ticketsResolvedChange)}%
                    </Badge>
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold">
                    {overview?.ticketsResolved ?? 0}
                  </p>
                  <p className="text-sm text-zinc-500">Tickets Resolved</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            {loadingOverview ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950">
                    <Clock className="h-5 w-5 text-emerald-600" />
                  </div>
                  {overview && (
                    <Badge
                      variant="secondary"
                      className={
                        overview.avgResolutionTimeChange <= 0
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }
                    >
                      <ArrowDownRight className="h-3 w-3 mr-1" />
                      {Math.abs(overview.avgResolutionTimeChange)}%
                    </Badge>
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold">
                    {overview?.avgResolutionTime ?? "0h"}
                  </p>
                  <p className="text-sm text-zinc-500">Avg Resolution Time</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            {loadingOverview ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
                    <Star className="h-5 w-5 text-amber-600" />
                  </div>
                  {overview && (
                    <Badge
                      variant="secondary"
                      className="bg-green-100 text-green-700"
                    >
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      {overview.customerSatisfactionChange}%
                    </Badge>
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold">
                    {overview?.customerSatisfaction ?? 0}%
                  </p>
                  <p className="text-sm text-zinc-500">Customer Satisfaction</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            {loadingOverview ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-950">
                    <CheckCircle2 className="h-5 w-5 text-purple-600" />
                  </div>
                  {overview && (
                    <Badge
                      variant="secondary"
                      className={
                        overview.activeTicketsChange <= 0
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }
                    >
                      <ArrowDownRight className="h-3 w-3 mr-1" />
                      {Math.abs(overview.activeTicketsChange)}
                    </Badge>
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-3xl font-bold">
                    {overview?.activeTickets ?? 0}
                  </p>
                  <p className="text-sm text-zinc-500">Active Tickets</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Weekly Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Ticket Volume</CardTitle>
            <CardDescription>
              Tickets received vs resolved in selected period
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingTickets ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : ticketVolume.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">No data available</p>
            ) : (
              <div className="space-y-4">
                {ticketVolume.map((day) => (
                  <div key={day.date} className="flex items-center gap-4">
                    <span className="w-10 text-sm font-medium text-zinc-500">
                      {formatDayLabel(day.date)}
                    </span>
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full h-4 overflow-hidden">
                        <div
                          className="bg-blue-500 h-full rounded-full"
                          style={{
                            width: `${(day.received / maxTickets) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="w-8 text-sm text-zinc-500">
                        {day.received}
                      </span>
                    </div>
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full h-4 overflow-hidden">
                        <div
                          className="bg-green-500 h-full rounded-full"
                          style={{
                            width: `${(day.resolved / maxTickets) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="w-8 text-sm text-zinc-500">
                        {day.resolved}
                      </span>
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
            )}
          </CardContent>
        </Card>

        {/* Category Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>By Category</CardTitle>
            <CardDescription>Ticket distribution by type</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingCategories ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
              </div>
            ) : categories.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">No data available</p>
            ) : (
              <div className="space-y-4">
                {categories.map((item) => (
                  <div key={item.category} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {item.category}
                      </span>
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
            )}
          </CardContent>
        </Card>
      </div>

      {/* Team Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Team Leaderboard</CardTitle>
          <CardDescription>Top performers in selected period</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingTeam ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : teamLeaderboard.length === 0 ? (
            <p className="text-center text-zinc-500 py-8">No data available</p>
          ) : (
            <div className="space-y-4">
              {teamLeaderboard.map((member, index) => (
                <div
                  key={member.id}
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
                      <p className="text-sm font-medium">
                        {member.ticketsResolved}
                      </p>
                      <p className="text-xs text-zinc-400">resolved</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {member.avgResolutionTime}
                      </p>
                      <p className="text-xs text-zinc-400">avg time</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">{member.satisfaction}%</p>
                      <p className="text-xs text-zinc-400">satisfaction</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
