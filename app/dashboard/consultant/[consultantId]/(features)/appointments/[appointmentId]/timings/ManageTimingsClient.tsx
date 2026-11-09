"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TimePicker } from "@/components/scheduling/TimePicker";
import { ClassPatternScheduler } from "@/components/scheduling/ClassPatternScheduler";
import {
  manageTimingsPolicy,
  type TimePickerSubject,
} from "@/components/scheduling/time-picker-policy";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { Button } from "@/components/ui/button";

/**
 * The consultant half of the manage-timings page. A class opens on its weekly
 * pattern scheduler (mobile-friendly, previews all N sessions); the week grid
 * stays one click away as the calendar view. The grid owns its own submit
 * (`useEventSlotAllocation` POSTs and toasts), so this only decides where to
 * go afterwards.
 */
export function ManageTimingsClient({
  subject,
  backHref,
  title,
}: Readonly<{
  subject: TimePickerSubject;
  backHref: string;
  title: string;
}>) {
  const router = useRouter();
  const { zone: viewerZone } = useViewerZone();
  // Replaces the generic "timings" crumb with the offering's own name (#1064).
  useSetBreadcrumbLabel(title);
  const isClass = subject.eventType === "class" && Boolean(subject.eventId);
  const [calendarView, setCalendarView] = useState(!isClass);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = manageTimingsPolicy({ onSubmit: goBack });

  if (isClass && !calendarView && subject.eventId) {
    return (
      <ClassPatternScheduler
        classId={subject.eventId}
        consultantId={subject.consultantProfileId}
        zone={subject.schedulingTimezone ?? viewerZone}
        sessionMinutes={Math.round((subject.sessionDurationInHours ?? 1) * 60)}
        totalSessions={subject.totalSessions ?? subject.sessionsPerWeek ?? 1}
        sessionsPerWeek={subject.sessionsPerWeek ?? 1}
        hasSessions={(subject.slots?.length ?? 0) > 0}
        onSaved={goBack}
        onUseCalendar={() => setCalendarView(true)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {isClass && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCalendarView(false)}
          >
            Schedule from a weekly pattern instead
          </Button>
        </div>
      )}
      <TimePicker
        className="min-h-0 flex-1"
        policy={policy}
        subject={subject}
        onCancel={goBack}
      />
    </div>
  );
}
