import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ConsultantProfile,
  PersonalInfoAndRole,
  PreferredSchedule,
} from "@/schemas/UserSchema";
import { Domain, SubDomain, Tag } from "@/schemas/PlanSchema";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsultantProfile> &
  Partial<PreferredSchedule> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    domain?: Domain;
    subDomains?: SubDomain[];
    tags?: Tag[];
    weeklySlots?: {
      dayOfWeekforStartTimeInUTC:
        | "MONDAY"
        | "TUESDAY"
        | "WEDNESDAY"
        | "THURSDAY"
        | "FRIDAY"
        | "SATURDAY"
        | "SUNDAY";
      slotStartTimeInUTC: string;
      dayOfWeekforEndTimeInUTC:
        | "MONDAY"
        | "TUESDAY"
        | "WEDNESDAY"
        | "THURSDAY"
        | "FRIDAY"
        | "SATURDAY"
        | "SUNDAY";
      slotEndTimeInUTC: string;
    }[];
    customSlots?: {
      slotStartTimeInUTC: string;
      slotEndTimeInUTC: string;
    }[];
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
  };

interface Props {
  onSubmit: (data: OnboardingFormData) => void;
  onBack: () => void;
  formData: OnboardingFormData;
}

const ConsultantReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
}) => {
  const handleSubmit = () => {
    onSubmit({
      ...formData,
      preferredCommunicationMethod:
        formData.preferredCommunicationMethod || "VIDEO",
    });
  };

  const formatTime = (timeString: string) => {
    try {
      const date = new Date(timeString);
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    } catch (error) {
      console.error("Error formatting time:", error);
      return timeString;
    }
  };

  const renderSchedule = () => {
    if (!formData.scheduleType) return null;

    return (
      <div>
        <h3 className="font-semibold">Schedule</h3>
        <p>Schedule Type: {formData.scheduleType}</p>
        {formData.scheduleType === "WEEKLY" && formData.weeklySlots && (
          <div>
            <h4 className="font-medium">Weekly Slots:</h4>
            <ul className="list-disc pl-5">
              {formData.weeklySlots.map((slot, index) => (
                <li key={index}>
                  {slot.dayOfWeekforStartTimeInUTC}{" "}
                  {formatTime(slot.slotStartTimeInUTC)} to{" "}
                  {slot.dayOfWeekforEndTimeInUTC}{" "}
                  {formatTime(slot.slotEndTimeInUTC)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {formData.scheduleType === "CUSTOM" && formData.customSlots && (
          <div>
            <h4 className="font-medium">Custom Slots:</h4>
            <ul className="list-disc pl-5">
              {formData.customSlots.map((slot, index) => (
                <li key={index}>
                  {new Date(slot.slotStartTimeInUTC).toLocaleDateString()}{" "}
                  {formatTime(slot.slotStartTimeInUTC)} to{" "}
                  {formatTime(slot.slotEndTimeInUTC)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold">Personal Information</h3>
            <p>Name: {formData.name}</p>
            <p>Email: {formData.email}</p>
            <p>Phone: {formData.phone || "Not provided"}</p>
            <p>Address: {formData.address || "Not provided"}</p>
          </div>
          <div>
            <h3 className="font-semibold">Professional Details</h3>
            <p>Description: {formData.description || "Not provided"}</p>
            <p>Qualifications: {formData.qualifications || "Not provided"}</p>
            <p>Specialization: {formData.specialization || "Not provided"}</p>
            <p>Experience: {formData.experience || "Not provided"}</p>
          </div>
          <div>
            <h3 className="font-semibold">Domain & Tags</h3>
            <p>Domain: {formData.domain?.name || "Not selected"}</p>
            <div>
              <h4 className="font-medium">Sub-Domains:</h4>
              <ul className="list-disc pl-5">
                {formData.subDomains?.map((subDomain) => (
                  <li key={subDomain.id}>{subDomain.name}</li>
                ))}
                {(!formData.subDomains || formData.subDomains.length === 0) && (
                  <li>No sub-domains selected</li>
                )}
              </ul>
            </div>
            <div>
              <h4 className="font-medium">Tags:</h4>
              <ul className="list-disc pl-5">
                {formData.tags?.map((tag) => <li key={tag.id}>{tag.name}</li>)}
                {(!formData.tags || formData.tags.length === 0) && (
                  <li>No tags selected</li>
                )}
              </ul>
            </div>
          </div>
          {renderSchedule()}
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="button" onClick={handleSubmit} variant="night">
          Submit
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
