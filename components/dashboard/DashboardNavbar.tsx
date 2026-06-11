"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { UserDropdown } from "./UserDropdown";
import { HelpCircle } from "lucide-react";
import Link from "next/link";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface DashboardNavbarProps {
  userName?: string | null;
  userImage?: string | null;
  userRole: "CONSULTANT" | "CONSULTEE" | "ADMIN" | "STAFF";
  settingsPath: string;
  profilePath?: string;
  helpPath?: string;
  breadcrumbs?: BreadcrumbItem[];
}

export function DashboardNavbar({
  userName,
  userImage,
  userRole,
  settingsPath,
  profilePath,
  helpPath,
  breadcrumbs,
}: DashboardNavbarProps) {
  return (
    <div
      className="flex h-16 items-center justify-end gap-2 px-6 border-b border-zinc-200 bg-white"
      style={{ overflow: "visible" }}
    >
      {/* Breadcrumbs — rendered in the left gutter when provided */}
      <div className="flex-1 flex items-center gap-1 text-sm min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 min-w-0">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && (
                  <span className="text-zinc-300 shrink-0">/</span>
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="text-zinc-500 hover:text-zinc-800 transition-colors truncate"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-zinc-700 font-medium truncate">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        )}
      </div>

      {/* Right actions */}
      <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-2">
          {helpPath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-zinc-500 hover:text-zinc-900"
                >
                  <Link href={helpPath}>
                    <HelpCircle className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Help & FAQ</TooltipContent>
            </Tooltip>
          )}

          <OrganizationSwitcher />

          <NotificationInbox />

          <UserDropdown
            userName={userName}
            userImage={userImage}
            userRole={userRole}
            settingsPath={settingsPath}
            profilePath={profilePath}
          />
        </div>
      </TooltipProvider>
    </div>
  );
}
