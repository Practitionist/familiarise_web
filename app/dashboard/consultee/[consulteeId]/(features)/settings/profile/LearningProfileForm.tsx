"use client";

import * as Sentry from "@sentry/nextjs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { SettingsSaveBar } from "@/components/dashboard/SettingsLayout";
import React, { useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { CareerStage, BudgetPreference } from "@prisma/client";
import { EducationSection } from "@/app/form/onboarding/components/experience/EducationSection";
import type { Education as EducationForm } from "@/app/form/onboarding/components/experience/EducationSection";
import { WorkExperienceSection } from "@/app/form/onboarding/components/experience/WorkExperienceSection";
import type { WorkExperience as WorkExperienceForm } from "@/app/form/onboarding/components/experience/WorkExperienceSection";

interface LearningProfileFormProps {
  consulteeId: string;
}

interface ProfileFormData {
  aboutMe: string | null;
  preferredLanguage: string | null;
  careerStage: CareerStage | null;
  skillsToDevelop: string[];
  budgetPreference: BudgetPreference | null;
  goals: string | null;
}

/**
 * Settings › Learning profile (#1527 §14): the learner fields that used to be
 * the whole consultee Settings page. Account and Notifications are their own
 * sections now, so this form no longer claims to manage the account.
 */
export default function LearningProfileForm({
  consulteeId,
}: LearningProfileFormProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = React.useState(false);

  const settingsQuery = createConsulteeQueries(consulteeId).settings;
  const {
    data: consulteeData,
    isLoading,
    error,
    refetch,
  } = useQuery(settingsQuery);

  const [profileSettings, setProfileSettings] = React.useState<ProfileFormData>(
    {
      aboutMe: null,
      preferredLanguage: null,
      goals: null,
      careerStage: null,
      skillsToDevelop: [],
      budgetPreference: null,
    },
  );

  const [educationList, setEducationList] = React.useState<EducationForm[]>([]);
  const [workExperienceList, setWorkExperienceList] = React.useState<
    WorkExperienceForm[]
  >([]);

  const handleProfileChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    const { name, value } = e.target;
    setProfileSettings((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // The saved values, derived from the last load; Reset restores them and
  // the save bar shows only while the form differs from them (#1527 §14).
  const saved = useMemo(() => {
    if (!consulteeData) return null;
    // The settings query uses TConsulteeProfileWithBackground, so
    // user.education and user.workExperiences are properly typed.
    const { user } = consulteeData;
    return {
      profileSettings: {
        aboutMe: consulteeData.aboutMe,
        preferredLanguage: consulteeData.preferredLanguage,
        goals: consulteeData.goals,
        careerStage: consulteeData.careerStage ?? null,
        skillsToDevelop: consulteeData.skillsToDevelop ?? [],
        budgetPreference: consulteeData.budgetPreference ?? null,
      } satisfies ProfileFormData,
      educationList: (user?.education ?? []).map(
        (edu): EducationForm => ({
          id: edu.id,
          institution: edu.institution,
          institutionDomain: edu.institutionDomain ?? undefined,
          degree: edu.degree,
          fieldOfStudy: edu.fieldOfStudy ?? undefined,
          startYear: edu.startYear ?? undefined,
          endYear: edu.endYear ?? undefined,
          grade: edu.grade ?? undefined,
          activities: edu.activities ?? undefined,
          description: edu.description ?? undefined,
        }),
      ),
      workExperienceList: (user?.workExperiences ?? []).map(
        (we): WorkExperienceForm => ({
          id: we.id,
          company: we.company,
          companyDomain: we.companyDomain ?? undefined,
          title: we.title,
          location: we.location ?? undefined,
          startDate: new Date(we.startDate),
          endDate: we.endDate ? new Date(we.endDate) : undefined,
          isCurrent: we.isCurrent,
          description: we.description ?? undefined,
        }),
      ),
    };
  }, [consulteeData]);

  const restore = useCallback(() => {
    if (!saved) return;
    setProfileSettings(saved.profileSettings);
    setEducationList(saved.educationList);
    setWorkExperienceList(saved.workExperienceList);
  }, [saved]);

  useEffect(() => {
    restore();
  }, [restore]);

  const isDirty =
    !!saved &&
    JSON.stringify({ profileSettings, educationList, workExperienceList }) !==
      JSON.stringify(saved);

  const handleEducationUpdate = useCallback((updated: EducationForm[]) => {
    setEducationList(updated);
  }, []);

  const handleWorkExperienceUpdate = useCallback(
    (updated: WorkExperienceForm[]) => {
      setWorkExperienceList(updated);
    },
    [],
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSaving(true);

      // Save profile settings
      const profileResponse = await fetch(
        `/api/user/consultees/${consulteeId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profileSettings),
        },
      );
      if (!profileResponse.ok) throw new Error("Failed to update profile");

      // Save education and work experience via the user's onboarding endpoint
      // Get userId from consultee data
      const userId = consulteeData?.user?.id;
      if (userId) {
        const bgResponse = await fetch(`/api/user/${userId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            educationHistory: educationList.map((edu) => ({
              institution: edu.institution,
              institutionDomain: edu.institutionDomain,
              degree: edu.degree,
              fieldOfStudy: edu.fieldOfStudy,
              startYear: edu.startYear,
              endYear: edu.endYear,
              grade: edu.grade,
              activities: edu.activities,
              description: edu.description,
            })),
            workExperiences: workExperienceList.map((we) => ({
              company: we.company,
              companyDomain: we.companyDomain,
              title: we.title,
              location: we.location,
              startDate: we.startDate,
              endDate: we.endDate,
              isCurrent: we.isCurrent,
              description: we.description,
            })),
          }),
        });
        if (!bgResponse.ok) {
          // Profile saved but background details didn't — say so instead of
          // reporting blanket success; the form stays dirty for a retry.
          toast({
            title: "Partially saved",
            description:
              "Your profile was saved, but education/work experience failed to update. Please try saving again.",
            variant: "destructive",
          });
          return;
        }
      }

      toast({ title: "Learning profile saved" });

      await refetch();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="animate-pulse space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="h-16 rounded bg-muted"></div>
              <div className="h-16 rounded bg-muted"></div>
            </div>
            <div className="h-32 rounded bg-muted"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // In-page error state — the old toast-only path left a form rendering
  // nulls after a failed load, which read like empty settings.
  if (error && !consulteeData) {
    return (
      <ErrorState
        title="Couldn't load your learning profile"
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>About you</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="preferredLanguage">Preferred Language</Label>
              <Input
                id="preferredLanguage"
                name="preferredLanguage"
                value={profileSettings.preferredLanguage ?? ""}
                onChange={handleProfileChange}
                placeholder="Your preferred language"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="careerStage">Career Stage</Label>
              <Select
                value={profileSettings.careerStage ?? ""}
                onValueChange={(value) =>
                  setProfileSettings((prev) => ({
                    ...prev,
                    careerStage: value as CareerStage,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select your career stage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CareerStage.STUDENT}>Student</SelectItem>
                  <SelectItem value={CareerStage.EARLY_CAREER}>
                    Early Career (0-3 years)
                  </SelectItem>
                  <SelectItem value={CareerStage.MID_CAREER}>
                    Mid Career (3-10 years)
                  </SelectItem>
                  <SelectItem value={CareerStage.SENIOR}>
                    Senior (10+ years)
                  </SelectItem>
                  <SelectItem value={CareerStage.EXECUTIVE}>
                    Executive
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="aboutMe">About Me</Label>
            <Textarea
              id="aboutMe"
              name="aboutMe"
              value={profileSettings.aboutMe ?? ""}
              onChange={handleProfileChange}
              placeholder="Tell us about yourself"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goals">Goals</Label>
            <Textarea
              id="goals"
              name="goals"
              value={profileSettings.goals ?? ""}
              onChange={handleProfileChange}
              placeholder="What you hope to achieve"
            />
          </div>
        </CardContent>
      </Card>

      {/* Work Experience Section */}
      <Card>
        <CardHeader>
          <CardTitle>Work Experience</CardTitle>
        </CardHeader>
        <CardContent>
          <WorkExperienceSection
            experiences={workExperienceList}
            onUpdate={handleWorkExperienceUpdate}
          />
        </CardContent>
      </Card>

      {/* Education Section */}
      <Card>
        <CardHeader>
          <CardTitle>Education</CardTitle>
        </CardHeader>
        <CardContent>
          <EducationSection
            education={educationList}
            onUpdate={handleEducationUpdate}
          />
        </CardContent>
      </Card>

      {/* Career & Professional Section */}
      <Card>
        <CardHeader>
          <CardTitle>Career Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="budgetPreference">Budget Preference</Label>
              <Select
                value={profileSettings.budgetPreference ?? ""}
                onValueChange={(value) =>
                  setProfileSettings((prev) => ({
                    ...prev,
                    budgetPreference: value as BudgetPreference,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select budget preference" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BudgetPreference.BUDGET}>
                    Budget
                  </SelectItem>
                  <SelectItem value={BudgetPreference.MODERATE}>
                    Moderate
                  </SelectItem>
                  <SelectItem value={BudgetPreference.PREMIUM}>
                    Premium
                  </SelectItem>
                  <SelectItem value={BudgetPreference.FLEXIBLE}>
                    Flexible
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skillsToDevelop">Skills to Develop</Label>
            <Input
              id="skillsToDevelop"
              value={(profileSettings.skillsToDevelop ?? []).join(", ")}
              onChange={(e) => {
                const skills = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                setProfileSettings((prev) => ({
                  ...prev,
                  skillsToDevelop: skills,
                }));
              }}
              placeholder="React, Python, Leadership (comma-separated)"
            />
          </div>
        </CardContent>
      </Card>

      <SettingsSaveBar
        isSaving={isSaving}
        isDirty={isDirty}
        onReset={restore}
      />
    </form>
  );
}
