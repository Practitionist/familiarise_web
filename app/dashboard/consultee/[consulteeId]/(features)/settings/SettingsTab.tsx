"use client";

import { Button } from "components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "components/ui/card";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { Textarea } from "components/ui/textarea";
import { useToast } from "hooks/use-toast";
import React, { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";
import { ConsultationMode, ConsulteeProfile } from "@prisma/client";

interface SettingsTabProps {
  consulteeId: string;
}

type ProfileFormData = Omit<
  Pick<
    ConsulteeProfile,
    | "education"
    | "occupation"
    | "aboutMe"
    | "preferredCommunicationMethod"
    | "preferredLanguage"
    | "specialRequirements"
    | "interests"
    | "goals"
  >,
  "preferredCommunicationMethod"
> & {
  preferredCommunicationMethod: ConsultationMode;
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
      education: null,
      occupation: null,
      aboutMe: null,
      preferredCommunicationMethod: ConsultationMode.VIDEO,
      preferredLanguage: null,
      specialRequirements: null,
      interests: null,
      goals: null,
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
        education: consulteeData.education,
        occupation: consulteeData.occupation,
        aboutMe: consulteeData.aboutMe,
        preferredCommunicationMethod:
          consulteeData.preferredCommunicationMethod ?? ConsultationMode.VIDEO,
        preferredLanguage: consulteeData.preferredLanguage,
        specialRequirements: consulteeData.specialRequirements,
        interests: consulteeData.interests,
        goals: consulteeData.goals,
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
    <div className="space-y-8 animate-fade-in">
      <div className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-600 rounded-2xl p-8 shadow-xl">
        <div className="absolute inset-0 bg-grid-white/10 [mask-image:linear-gradient(0deg,transparent,white)]"></div>
        <div className="relative z-10">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-2">Settings</h2>
          <p className="text-blue-100 text-lg">
            Manage your account settings and preferences
          </p>
        </div>
        <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white/10 rounded-full blur-3xl"></div>
      </div>

      <Card className="border-2 border-gray-100 shadow-xl rounded-2xl overflow-hidden">
        <CardHeader className="bg-gradient-to-r from-gray-50 to-white border-b-2 border-gray-100 p-6">
          <CardTitle className="text-2xl font-bold text-gray-900">Profile Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="education" className="text-sm font-semibold text-gray-700">Education</Label>
              <Input
                id="education"
                name="education"
                value={profileSettings.education ?? ""}
                onChange={handleProfileChange}
                placeholder="Your educational background"
                className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="occupation" className="text-sm font-semibold text-gray-700">Occupation</Label>
              <Input
                id="occupation"
                name="occupation"
                value={profileSettings.occupation ?? ""}
                onChange={handleProfileChange}
                placeholder="Your current occupation"
                className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preferredLanguage" className="text-sm font-semibold text-gray-700">Preferred Language</Label>
              <Input
                id="preferredLanguage"
                name="preferredLanguage"
                value={profileSettings.preferredLanguage ?? ""}
                onChange={handleProfileChange}
                placeholder="Your preferred language"
                className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preferredCommunicationMethod" className="text-sm font-semibold text-gray-700">
                Communication Method
              </Label>
              <select
                id="preferredCommunicationMethod"
                name="preferredCommunicationMethod"
                value={profileSettings.preferredCommunicationMethod.toString()}
                onChange={handleProfileChange}
                className="w-full rounded-lg border-2 border-gray-200 bg-white px-4 py-2.5 text-sm font-medium focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200 cursor-pointer"
              >
                <option value={ConsultationMode.VIDEO}>Video</option>
                <option value={ConsultationMode.AUDIO}>Audio</option>
                <option value={ConsultationMode.IN_PERSON}>In Person</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="aboutMe" className="text-sm font-semibold text-gray-700">About Me</Label>
            <Textarea
              id="aboutMe"
              name="aboutMe"
              value={profileSettings.aboutMe ?? ""}
              onChange={handleProfileChange}
              placeholder="Tell us about yourself"
              className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200 min-h-[100px]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="specialRequirements" className="text-sm font-semibold text-gray-700">Special Requirements</Label>
            <Textarea
              id="specialRequirements"
              name="specialRequirements"
              value={profileSettings.specialRequirements ?? ""}
              onChange={handleProfileChange}
              placeholder="Any special requirements or accommodations needed"
              className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200 min-h-[100px]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="interests" className="text-sm font-semibold text-gray-700">Interests</Label>
            <Textarea
              id="interests"
              name="interests"
              value={profileSettings.interests ?? ""}
              onChange={handleProfileChange}
              placeholder="Your interests and areas you'd like to explore"
              className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200 min-h-[100px]"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="goals" className="text-sm font-semibold text-gray-700">Goals</Label>
            <Textarea
              id="goals"
              name="goals"
              value={profileSettings.goals ?? ""}
              onChange={handleProfileChange}
              placeholder="What you hope to achieve"
              className="rounded-lg border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all duration-200 min-h-[100px]"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold px-8 py-3 rounded-xl shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105"
          disabled={isSaving}
        >
          {isSaving ? (
            <span className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
              Saving...
            </span>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  );
}
