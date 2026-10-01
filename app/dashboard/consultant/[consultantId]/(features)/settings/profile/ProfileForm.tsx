"use client";

import { SettingsIcon } from "lucide-react";
import type { TConsultantProfile } from "types/consultant";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/DataCard";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ProfileSection } from "../sections/ProfileSection";
import { SettingsFormActions } from "../SettingsFormActions";
import { useConsultantSettingsForm } from "../use-consultant-settings-form";

/** The Profile section's form — the domain lists ride in with `content`. */
export function ProfileForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const form = useConsultantSettingsForm(consultant, { content: true });

  if (form.isContentLoading || form.timezoneLoading) {
    return <SettingsSkeleton />;
  }

  if (form.contentError && form.domains.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={SettingsIcon}
            title="Couldn't load settings data"
            description="The domain and expertise options failed to load. Please retry."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void form.fetchContentData()}
              >
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <form
      onSubmit={form.handleSubmit}
      className="space-y-6"
      aria-label="Profile form"
    >
      <Card>
        <CardContent className="p-6 space-y-8">
          <ProfileSection
            formData={form.formData}
            setFormData={form.setFormData}
            domains={form.domains}
            subDomainOptions={form.subDomainOptions}
            tagOptions={form.tagOptions}
            onInputChange={form.handleInputChange}
            onDomainChange={form.handleDomainChange}
            onSubDomainChange={form.handleSubDomainChange}
            onTagChange={form.handleTagChange}
          />
        </CardContent>
      </Card>
      <SettingsFormActions isSaving={form.isSaving} onReset={form.reset} />
    </form>
  );
}
