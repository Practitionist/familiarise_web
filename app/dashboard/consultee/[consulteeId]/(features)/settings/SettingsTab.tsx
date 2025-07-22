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
    refetch 
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
              <Label htmlFor="education">Education</Label>
              <Input
                id="education"
                name="education"
                value={profileSettings.education ?? ""}
                onChange={handleProfileChange}
                placeholder="Your educational background"
              />
            </div>
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
            <Label htmlFor="specialRequirements">Special Requirements</Label>
            <Textarea
              id="specialRequirements"
              name="specialRequirements"
              value={profileSettings.specialRequirements ?? ""}
              onChange={handleProfileChange}
              placeholder="Any special requirements or accommodations needed"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="interests">Interests</Label>
            <Textarea
              id="interests"
              name="interests"
              value={profileSettings.interests ?? ""}
              onChange={handleProfileChange}
              placeholder="Your interests and areas you'd like to explore"
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
