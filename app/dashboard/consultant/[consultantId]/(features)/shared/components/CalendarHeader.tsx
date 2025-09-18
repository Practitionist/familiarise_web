"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  Users,
  Zap,
  RotateCcw,
} from "lucide-react";
import { format } from "date-fns";

interface CalendarHeaderProps {
  view: "week" | "month";
  currentDate: Date;
  onViewChange: (view: "week" | "month") => void;
  onDateChange: (date: Date) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  
  // Event information
  eventType?: "consultation" | "subscription" | "webinar" | "class";
  mode?: "select" | "view";
  
  // Progress information for display
  footerInfo?: {
    selectedCount?: number;
    requiredSlots?: number;
    progressText?: string;
    timezone?: string;
  };

  // Action buttons
  showAutoAllocate?: boolean;
  showClearSelection?: boolean;
  onAutoAllocate?: () => void;
  onClearSelection?: () => void;
  autoAllocateDisabled?: boolean;
  clearSelectionDisabled?: boolean;
}

export function CalendarHeader({
  view,
  currentDate,
  onViewChange,
  onDateChange,
  onPrevious,
  onNext,
  onToday,
  eventType,
  mode,
  footerInfo,
  showAutoAllocate,
  showClearSelection,
  onAutoAllocate,
  onClearSelection,
  autoAllocateDisabled = false,
  clearSelectionDisabled = false,
}: CalendarHeaderProps) {
  return (
    <div className="space-y-4">
      {/* Navigation Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h2 className="text-xl font-semibold">
            {format(currentDate, view === "week" ? "MMM d, yyyy" : "MMMM yyyy")}
          </h2>
          <div className="flex items-center space-x-1">
            <Button variant="outline" size="sm" onClick={onPrevious}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={onNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={onToday}>
              Today
            </Button>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* View Toggle */}
          <div className="flex items-center border rounded-md">
            <Button
              variant={view === "week" ? "default" : "ghost"}
              size="sm"
              onClick={() => onViewChange("week")}
              className="rounded-r-none"
            >
              <Calendar className="h-4 w-4 mr-1" />
              Week
            </Button>
            <Button
              variant={view === "month" ? "default" : "ghost"}
              size="sm"
              onClick={() => onViewChange("month")}
              className="rounded-l-none"
            >
              <Calendar className="h-4 w-4 mr-1" />
              Month
            </Button>
          </div>

          {/* Action Buttons */}
          {mode === "select" && (
            <div className="flex items-center space-x-2">
              {showAutoAllocate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onAutoAllocate}
                  disabled={autoAllocateDisabled}
                >
                  <Zap className="h-4 w-4 mr-1" />
                  Auto Allocate
                </Button>
              )}
              {showClearSelection && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onClearSelection}
                  disabled={clearSelectionDisabled}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Event Type Badge */}
      {eventType && (
        <div className="flex items-center space-x-2">
          <Badge variant="outline" className="capitalize">
            {eventType === "consultation" && <Clock className="h-3 w-3 mr-1" />}
            {eventType === "subscription" && <Users className="h-3 w-3 mr-1" />}
            {eventType === "webinar" && <Calendar className="h-3 w-3 mr-1" />}
            {eventType === "class" && <Users className="h-3 w-3 mr-1" />}
            {eventType}
          </Badge>
          {mode && (
            <Badge variant={mode === "select" ? "default" : "secondary"}>
              {mode === "select" ? "Selection Mode" : "View Mode"}
            </Badge>
          )}
        </div>
      )}

      {/* Footer Information */}
      {footerInfo && (
        <div className="bg-gray-50 p-3 rounded-lg">
          <div className="flex items-center justify-between text-sm">
            <div className="space-y-1">
              {footerInfo.selectedCount !== undefined && footerInfo.requiredSlots !== undefined && (
                <div>
                  <strong>Selected:</strong> {footerInfo.selectedCount}/{footerInfo.requiredSlots} slots
                </div>
              )}
              {footerInfo.progressText && (
                <div>{footerInfo.progressText}</div>
              )}
            </div>
            {footerInfo.timezone && (
              <div className="text-muted-foreground">
                <strong>Timezone:</strong> {footerInfo.timezone}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}