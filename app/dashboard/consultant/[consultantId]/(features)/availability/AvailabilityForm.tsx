"use client";

import type { TConsultantProfile } from "types/consultant";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { AvailabilitySection } from "../settings/sections/AvailabilitySection";
import { SettingsFormActions } from "../settings/SettingsFormActions";
import { useConsultantSettingsForm } from "../settings/use-consultant-settings-form";

/**
 * The Availability page's form (#1785 L-1). The section component is the one
 * the settings tab mounted; only the page around it moved.
 */
export function AvailabilityForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const form = useConsultantSettingsForm(consultant, { scheduleSwitch: true });

  if (form.timezoneLoading) return <SettingsSkeleton />;

  return (
    <form
      onSubmit={form.handleSubmit}
      className="space-y-6"
      aria-label="Availability form"
    >
      <Card>
        <CardContent className="p-6 space-y-8">
          <AvailabilitySection
            scheduleType={form.scheduleType}
            canSwitchSchedule={form.canSwitchSchedule}
            scheduleSwitchBlockedReason={form.scheduleSwitchBlockedReason}
            onScheduleTypeChange={form.handleScheduleTypeChange}
            weeklySlots={form.weeklySlots}
            customSlots={form.customSlots}
            currentDate={form.currentDate}
            onPrevMonth={form.handlePrevMonth}
            onNextMonth={form.handleNextMonth}
            onToggleCustomDate={form.handleToggleCustomDate}
            onAddSlot={form.handleAddSlot}
            onUpdateSlot={form.handleUpdateSlot}
            onDeleteSlot={form.handleDeleteSlot}
          />
        </CardContent>
      </Card>
      <SettingsFormActions isSaving={form.isSaving} onReset={form.reset} />
    </form>
  );
}
