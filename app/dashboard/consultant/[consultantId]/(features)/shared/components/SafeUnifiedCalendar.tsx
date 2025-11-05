"use client";

import { UnifiedCalendar, UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";

export function SafeUnifiedCalendar(props: UnifiedCalendarProps) {
  return (
    <CalendarErrorBoundary>
      <UnifiedCalendar {...props} />
    </CalendarErrorBoundary>
  );
}
