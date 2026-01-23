"use client";

import { cn } from "@/lib/utils";
import {
  CreditCard,
  Home,
  MessageSquare,
  Settings,
  Shield,
  Ticket,
  Users,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Wallet,
  Receipt,
  Star,
  Play,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const sidebarItems = [
  { name: "Home", icon: Home, path: "home" },
  { name: "Support Tickets", icon: Ticket, path: "tickets" },
  { name: "User Feedback", icon: Star, path: "feedback" },
  { name: "Users", icon: Users, path: "users" },
  { name: "Content Moderation", icon: Shield, path: "moderation" },
  { name: "Appointments", icon: Calendar, path: "appointments" },
  { name: "Payments", icon: CreditCard, path: "payments" },
  { name: "Payouts", icon: Wallet, path: "payouts" },
  { name: "Invoices", icon: Receipt, path: "invoices" },
  { name: "System Jobs", icon: Play, path: "system-jobs" },
  { name: "Team Chat", icon: MessageSquare, path: "chat" },
  { name: "Settings", icon: Settings, path: "settings" },
];

export default function StaffDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname();
  const staffId = params.staffId as string;
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (path: string) => {
    return pathname.includes(`/staff/${staffId}/${path}`);
  };

  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 transition-all duration-300",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-zinc-200 dark:border-zinc-800">
          {!collapsed && (
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Staff Portal
            </h1>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-8 w-8"
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4">
          <TooltipProvider delayDuration={0}>
            <ul className="space-y-1 px-2">
              {sidebarItems.map((item) => (
                <li key={item.path}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={`/dashboard/staff/${staffId}/${item.path}`}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                          isActive(item.path)
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                        )}
                      >
                        <item.icon className="h-5 w-5 flex-shrink-0" />
                        {!collapsed && <span>{item.name}</span>}
                      </Link>
                    </TooltipTrigger>
                    {collapsed && (
                      <TooltipContent side="right">{item.name}</TooltipContent>
                    )}
                  </Tooltip>
                </li>
              ))}
            </ul>
          </TooltipProvider>
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Familiarise Staff v1.0
            </p>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
