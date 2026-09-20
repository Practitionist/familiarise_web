"use client";

import { Button } from "components/ui/button";
import { Card, CardContent } from "components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "components/ui/tabs";
import { SettingsIcon } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TConsultantProfile } from "types/consultant";
import { EmptyState } from "@/components/dashboard/DataCard";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ProfileSection } from "./sections/ProfileSection";
import { VerificationSection } from "./sections/VerificationSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { BookingRequestsSection } from "./sections/BookingRequestsSection";
import { SecuritySection } from "./sections/SecuritySection";
import { SettingsFormActions } from "./SettingsFormActions";
import { useConsultantSettingsForm } from "./use-consultant-settings-form";

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

const SETTINGS_TABS = [
  { key: "profile", label: "Profile" },
  { key: "booking", label: "Booking requests" },
  { key: "verification", label: "Verification" },
  { key: "notifications", label: "Notifications" },
  { key: "security", label: "Security" },
] as const;

type SettingsTabKey = (typeof SETTINGS_TABS)[number]["key"];

// Tabs whose content needs the domain/expertise payload; the rest
// (verification, notifications, security) render without it.
const CONTENT_DEPENDENT_TABS = ["profile", "booking"] as const;

const isSettingsTabKey = (v: string | null): v is SettingsTabKey =>
  !!v && SETTINGS_TABS.some((t) => t.key === v);

/**
 * Consultant settings — orchestrator for the section tabs. Availability is a
 * top-level page now (#1785 L-1); the form state and the combined PUT live in
 * `useConsultantSettingsForm`, shared with that page.
 */
export function SettingsTab({ consultant }: Readonly<SettingsTabProps>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const form = useConsultantSettingsForm(consultant, { content: true });

  // Active tab from the URL (default: profile; invalid values fall back).
  // URL writes go through window.history.replaceState rather than
  // router.replace (same discipline as components/dashboard/UrlTabs.tsx).
  const tabParam = searchParams.get("tab");
  const urlTab: SettingsTabKey = isSettingsTabKey(tabParam)
    ? tabParam
    : "profile";
  const [localTab, setLocalTab] = useState<SettingsTabKey | null>(null);
  const activeTab: SettingsTabKey = localTab ?? urlTab;
  useEffect(() => {
    setLocalTab(null);
  }, [tabParam]);
  const handleTabChange = (value: string) => {
    const next = isSettingsTabKey(value) ? value : "profile";
    setLocalTab(next);
    const target = `${pathname}?tab=${next}`;
    const current = window.location.pathname + window.location.search;
    if (target !== current) {
      window.history.replaceState(window.history.state, "", target);
    }
  };

  if (form.isContentLoading || form.timezoneLoading) {
    return <SettingsSkeleton />;
  }

  if (
    form.contentError &&
    form.domains.length === 0 &&
    (CONTENT_DEPENDENT_TABS as readonly string[]).includes(activeTab)
  ) {
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
      role="form"
      aria-label="Settings form"
    >
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-6 space-y-8">
          {activeTab === "profile" && (
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
          )}

          {activeTab === "booking" && (
            <BookingRequestsSection
              formData={form.formData}
              setFormData={form.setFormData}
            />
          )}

          {activeTab === "verification" && (
            <VerificationSection consultant={consultant} />
          )}

          {activeTab === "notifications" && <NotificationsSection />}

          {activeTab === "security" && <SecuritySection />}
        </CardContent>
      </Card>

      <SettingsFormActions isSaving={form.isSaving} onReset={form.reset} />
    </form>
  );
}
