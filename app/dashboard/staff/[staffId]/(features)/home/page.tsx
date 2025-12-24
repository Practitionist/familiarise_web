"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Ticket,
  Users,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingUp,
  ArrowRight,
  Bell,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

// Mock data - replace with real data fetching
const stats = [
  {
    title: "Open Tickets",
    value: "24",
    change: "+3 from yesterday",
    icon: Ticket,
    color: "text-blue-600",
    bgColor: "bg-blue-50 dark:bg-blue-950",
  },
  {
    title: "Users Assisted",
    value: "156",
    change: "+12 this week",
    icon: Users,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50 dark:bg-emerald-950",
  },
  {
    title: "Pending Reviews",
    value: "8",
    change: "3 urgent",
    icon: AlertTriangle,
    color: "text-amber-600",
    bgColor: "bg-amber-50 dark:bg-amber-950",
  },
  {
    title: "Resolved Today",
    value: "18",
    change: "92% satisfaction",
    icon: CheckCircle2,
    color: "text-green-600",
    bgColor: "bg-green-50 dark:bg-green-950",
  },
];

const recentTickets = [
  {
    id: "TKT-001",
    subject: "Payment not processed",
    user: "John Doe",
    status: "open",
    priority: "high",
    time: "5 min ago",
  },
  {
    id: "TKT-002",
    subject: "Cannot schedule appointment",
    user: "Jane Smith",
    status: "in_progress",
    priority: "medium",
    time: "15 min ago",
  },
  {
    id: "TKT-003",
    subject: "Profile verification issue",
    user: "Mike Wilson",
    status: "open",
    priority: "low",
    time: "1 hour ago",
  },
  {
    id: "TKT-004",
    subject: "Refund request",
    user: "Sarah Connor",
    status: "pending",
    priority: "high",
    time: "2 hours ago",
  },
];

const announcements = [
  {
    title: "System Maintenance Scheduled",
    description: "Platform maintenance on Saturday 2 AM - 4 AM IST",
    date: "Dec 21, 2025",
    type: "warning",
  },
  {
    title: "New Ticket Categories Added",
    description: "Please review the updated ticket categorization guidelines",
    date: "Dec 19, 2025",
    type: "info",
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "open":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "in_progress":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "pending":
      return "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300";
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority) {
    case "high":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "low":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  }
};

export default function StaffHomePage() {
  const params = useParams();
  const staffId = params.staffId as string;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Dashboard
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Welcome back! Here&apos;s what&apos;s happening today.
          </p>
        </div>
        <Button variant="outline" className="gap-2">
          <Bell className="h-4 w-4" />
          Notifications
          <Badge variant="destructive" className="ml-1">
            3
          </Badge>
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <TrendingUp className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="mt-4">
                <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                  {stat.value}
                </p>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {stat.title}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  {stat.change}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Tickets */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Recent Tickets</CardTitle>
              <CardDescription>
                Latest support tickets requiring attention
              </CardDescription>
            </div>
            <Link href={`/dashboard/staff/${staffId}/tickets`}>
              <Button variant="ghost" size="sm" className="gap-1">
                View all
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src="" />
                      <AvatarFallback className="text-xs">
                        {ticket.user
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {ticket.subject}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {ticket.id} • {ticket.user}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={getPriorityColor(ticket.priority)}
                      variant="secondary"
                    >
                      {ticket.priority}
                    </Badge>
                    <Badge
                      className={getStatusColor(ticket.status)}
                      variant="secondary"
                    >
                      {ticket.status.replace("_", " ")}
                    </Badge>
                    <span className="text-xs text-zinc-400 ml-2 hidden sm:inline">
                      {ticket.time}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Announcements */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              Announcements
            </CardTitle>
            <CardDescription>Important updates from admin</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {announcements.map((announcement, index) => (
                <div
                  key={index}
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <div className="flex items-start gap-2">
                    {announcement.type === "warning" ? (
                      <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5" />
                    ) : (
                      <Bell className="h-4 w-4 text-blue-500 mt-0.5" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {announcement.title}
                      </p>
                      <p className="text-xs text-zinc-500 mt-1">
                        {announcement.description}
                      </p>
                      <p className="text-xs text-zinc-400 mt-2">
                        {announcement.date}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks and shortcuts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link href={`/dashboard/staff/${staffId}/tickets`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Ticket className="h-4 w-4" />
                View Open Tickets
              </Button>
            </Link>
            <Link href={`/dashboard/staff/${staffId}/users`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Users className="h-4 w-4" />
                Search Users
              </Button>
            </Link>
            <Link href={`/dashboard/staff/${staffId}/moderation`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <AlertTriangle className="h-4 w-4" />
                Review Content
              </Button>
            </Link>
            <Link href={`/dashboard/staff/${staffId}/knowledge-base`}>
              <Button variant="outline" className="w-full justify-start gap-2">
                <Clock className="h-4 w-4" />
                Knowledge Base
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
