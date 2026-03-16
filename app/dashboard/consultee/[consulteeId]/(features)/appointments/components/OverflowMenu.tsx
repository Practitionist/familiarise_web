"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  X,
  AlertCircle,
  ExternalLink,
  Video,
} from "lucide-react";

interface OverflowMenuProps {
  eventType: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  isActive: boolean;
  isPendingPayment: boolean;
  hasAppointmentId: boolean;
  isDev: boolean;
  canDevJoin: boolean;
  isLoading?: boolean;
  onCancel: () => void;
  onReportIssue: () => void;
  onViewPlanDetails?: () => void;
  onDevJoin?: () => void;
}

export function OverflowMenu({
  isActive,
  isPendingPayment,
  hasAppointmentId,
  isDev,
  canDevJoin,
  isLoading,
  onCancel,
  onReportIssue,
  onViewPlanDetails,
  onDevJoin,
}: OverflowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0 border-zinc-200"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onViewPlanDetails && (
          <DropdownMenuItem onClick={onViewPlanDetails}>
            <ExternalLink className="h-4 w-4 mr-2" />
            View Plan Details
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={onReportIssue}
          disabled={!hasAppointmentId || isLoading}
        >
          <AlertCircle className="h-4 w-4 mr-2" />
          Report Issue
        </DropdownMenuItem>
        {isActive && !isPendingPayment && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCancel}
              disabled={isLoading}
              className="text-red-600 focus:text-red-600"
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </DropdownMenuItem>
          </>
        )}
        {isDev && canDevJoin && onDevJoin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDevJoin}
              className="text-amber-600 focus:text-amber-600"
            >
              <Video className="h-4 w-4 mr-2" />
              Force Join (dev)
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
