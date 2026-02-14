"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { UserDropdown } from "./UserDropdown";
import { HelpCircle } from "lucide-react";
import Link from "next/link";

interface DashboardNavbarProps {
  userName?: string | null;
  userImage?: string | null;
  userRole: "CONSULTANT" | "CONSULTEE" | "ADMIN" | "STAFF";
  settingsPath: string;
  profilePath?: string;
  helpPath?: string;
}

export function DashboardNavbar({
  userName,
  userImage,
  userRole,
  settingsPath,
  profilePath,
  helpPath,
}: DashboardNavbarProps) {
  return (
    <div
      className="flex items-center justify-end gap-2 px-6 py-2 border-b border-zinc-200/50 bg-white/80 backdrop-blur-xl"
      style={{ zIndex: 9999, overflow: "visible" }}
    >
      {/* Left spacer - future home for breadcrumbs */}
      <div className="flex-1" />

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
