"use client";

import { Button } from "components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "components/ui/card";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { Textarea } from "components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { NotificationPreferencesPanel } from "@/components/notifications";
import React, { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import {
  ConsultationMode,
  ConsulteeProfile,
  CareerStage,
  BudgetPreference,
} from "@prisma/client";

interface SettingsTabProps {
  consulteeId: string;
}

type ProfileFormData = Omit<
  Pick<
    ConsulteeProfile,
    | "occupation"
    | "aboutMe"
    | "preferredCommunicationMethod"
    | "preferredLanguage"
    | "careerStage"
    | "currentCompany"
    | "industry"
    | "skillsToDevelop"
    | "budgetPreference"
  >,
  "preferredCommunicationMethod" | "careerStage" | "budgetPreference"
> & {
  preferredCommunicationMethod: ConsultationMode;
  careerStage: CareerStage | null;
  budgetPreference: BudgetPreference | null;
  goals: string | null;
};

export default function SettingsTab({ consulteeId }: SettingsTabProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = React.useState(false);

  // Use the centralized query configuration
  const settingsQuery = createConsulteeQueries(consulteeId).settings;
  const {
    data: consulteeData,
    isLoading,
    error,
    refetch,
  } = useQuery(settingsQuery);

  const [profileSettings, setProfileSettings] = React.useState<ProfileFormData>(
    {
      occupation: null,
      aboutMe: null,
      preferredCommunicationMethod: ConsultationMode.VIDEO,
      preferredLanguage: null,
      goals: null,
      // New fields
      careerStage: null,
      currentCompany: null,
      industry: null,
      skillsToDevelop: [],
      budgetPreference: null,
    },
  );

  const handleProfileChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    const { name, value } = e.target;
    setProfileSettings((prev) => ({
      ...prev,
      [name]:
        name === "preferredCommunicationMethod"
          ? (value as ConsultationMode)
          : value,
    }));
  };

  // Update local state when data is loaded
  useEffect(() => {
    if (consulteeData) {
      setProfileSettings({
        occupation: consulteeData.occupation,
        aboutMe: consulteeData.aboutMe,
        preferredCommunicationMethod:
          consulteeData.preferredCommunicationMethod ?? ConsultationMode.VIDEO,
        preferredLanguage: consulteeData.preferredLanguage,
        goals: consulteeData.goals,
        // New fields
        careerStage: consulteeData.careerStage ?? null,
        currentCompany: consulteeData.currentCompany ?? null,
        industry: consulteeData.industry ?? null,
        skillsToDevelop: consulteeData.skillsToDevelop ?? [],
        budgetPreference: consulteeData.budgetPreference ?? null,
      });
    }
  }, [consulteeData]);

  // Handle errors
  useEffect(() => {
    if (error) {
      toast({
        title: "Error",
        description: "Failed to load profile settings.",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      const response = await fetch(`/api/user/consultees/${consulteeId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(profileSettings),
      });

      if (!response.ok) throw new Error("Failed to update profile");

      toast({
        title: "Settings saved",
        description: "Your settings have been updated successfully.",
      });

      // Refetch to update the cached data
      refetch();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Show loading skeleton while initial data is loading
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-6">
          <h2 className="text-3xl font-bold text-gray-900">Settings</h2>
          <p className="mt-2 text-gray-600">
            Manage your account settings and preferences
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Profile Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="animate-pulse space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="h-16 bg-gray-200 rounded"></div>
                <div className="h-16 bg-gray-200 rounded"></div>
              </div>
              <div className="h-32 bg-gray-200 rounded"></div>
              <div className="h-16 bg-gray-200 rounded"></div>
              <div className="h-32 bg-gray-200 rounded"></div>
              <div className="h-32 bg-gray-200 rounded"></div>
              <div className="h-32 bg-gray-200 rounded"></div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-6">
        <h2 className="text-3xl font-bold text-gray-900">Settings</h2>
        <p className="mt-2 text-gray-600">
          Manage your account settings and preferences
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="occupation">Occupation</Label>
              <Input
                id="occupation"
                name="occupation"
                value={profileSettings.occupation ?? ""}
                onChange={handleProfileChange}
                placeholder="Your current occupation"
              />
            </div>
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
              <Label htmlFor="preferredCommunicationMethod">
                Communication Method
              </Label>
              <select
                id="preferredCommunicationMethod"
                name="preferredCommunicationMethod"
                value={profileSettings.preferredCommunicationMethod.toString()}
                onChange={handleProfileChange}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value={ConsultationMode.VIDEO}>Video</option>
                <option value={ConsultationMode.AUDIO}>Audio</option>
                <option value={ConsultationMode.IN_PERSON}>In Person</option>
              </select>
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

      {/* Career & Professional Section */}
      <Card>
        <CardHeader>
          <CardTitle>Career & Professional</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="currentCompany">Current Company</Label>
              <Input
                id="currentCompany"
                name="currentCompany"
                value={profileSettings.currentCompany ?? ""}
                onChange={handleProfileChange}
                placeholder="Your current company or organization"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Input
                id="industry"
                name="industry"
                value={profileSettings.industry ?? ""}
                onChange={handleProfileChange}
                placeholder="Your industry (e.g., Technology, Healthcare)"
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

      {/* Notification Preferences */}
      <NotificationPreferencesPanel />

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          className="bg-blue-600 hover:bg-blue-700"
          disabled={isSaving}
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
