import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ConsultantProfile,
  PersonalInfoAndRole,
  PreferredSchedule,
} from "@/schemas/UserSchema";
import { Domain, SubDomain, Tag } from "@/schemas/PlanSchema";
import { formatTime, formatDate } from "../timeUtils";

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

  const isValidSlot = (slot: {
    slotStartTimeInUTC: string;
    slotEndTimeInUTC: string;
  }): boolean => {
    const startTime = formatTime(slot.slotStartTimeInUTC, "12h");
    const endTime = formatTime(slot.slotEndTimeInUTC, "12h");
    return startTime !== endTime;
  };

  const renderSchedule = () => {
    if (!formData.scheduleType) return null;

    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-gray-900">Schedule</h3>
        <p className="text-sm text-gray-600">
          Schedule Type:{" "}
          <span className="font-medium">{formData.scheduleType}</span>
        </p>
        {formData.scheduleType === "WEEKLY" && formData.weeklySlots && (
          <div className="space-y-2">
            <h4 className="text-md font-medium text-gray-800">Weekly Slots</h4>
            <ul className="space-y-2 list-none pl-0">
              {formData.weeklySlots.filter(isValidSlot).map((slot, index) => {
                const startTime = formatTime(slot.slotStartTimeInUTC, "12h");
                const endTime = formatTime(slot.slotEndTimeInUTC, "12h");
                const isSameDay =
                  slot.dayOfWeekforStartTimeInUTC ===
                  slot.dayOfWeekforEndTimeInUTC;

                return (
                  <li
                    key={index}
                    className="px-4 py-2 bg-gray-50 rounded-lg text-sm text-gray-700"
                  >
                    <span className="font-medium">
                      {slot.dayOfWeekforStartTimeInUTC}
                    </span>{" "}
                    <span className="text-gray-600">{startTime}</span>
                    {" to "}
                    {!isSameDay && (
                      <span className="font-medium">
                        {slot.dayOfWeekforEndTimeInUTC}{" "}
                      </span>
                    )}
                    <span className="text-gray-600">{endTime}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {formData.scheduleType === "CUSTOM" && formData.customSlots && (
          <div className="space-y-2">
            <h4 className="text-md font-medium text-gray-800">Custom Slots</h4>
            <ul className="space-y-2 list-none pl-0">
              {formData.customSlots.filter(isValidSlot).map((slot, index) => {
                const startDate = formatDate(slot.slotStartTimeInUTC);
                const endDate = formatDate(slot.slotEndTimeInUTC);
                const startTime = formatTime(slot.slotStartTimeInUTC, "12h");
                const endTime = formatTime(slot.slotEndTimeInUTC, "12h");
                const isSameDay = startDate === endDate;

                return (
                  <li
                    key={index}
                    className="px-4 py-2 bg-gray-50 rounded-lg text-sm text-gray-700"
                  >
                    <span className="font-medium">{startDate}</span>{" "}
                    <span className="text-gray-600">{startTime}</span>
                    {" to "}
                    {!isSameDay && (
                      <span className="font-medium">{endDate} </span>
                    )}
                    <span className="text-gray-600">{endTime}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  };

  const renderSection = (
    title: string,
    content: React.ReactNode,
    className: string = "",
  ) => (
    <div className={`space-y-3 ${className}`}>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      {content}
    </div>
  );

  const renderList = (
    items: { id: string; name: string }[] | undefined,
    emptyMessage: string,
  ) => (
    <ul className="list-none pl-0 space-y-1">
      {items?.map((item) => (
        <li
          key={item.id}
          className="px-3 py-1.5 bg-gray-50 rounded-md text-sm text-gray-700"
        >
          {item.name}
        </li>
      ))}
      {(!items || items.length === 0) && (
        <li className="text-sm text-gray-500 italic">{emptyMessage}</li>
      )}
    </ul>
  );

  return (
    <div className="w-full max-w-2xl mx-auto space-y-6">
      <Card className="shadow-lg border-gray-200">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-gray-900">
            Review Your Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {renderSection(
            "Personal Information",
            <div className="grid gap-2 text-sm">
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">Name</span>
                <span className="col-span-2 text-gray-900">
                  {formData.name}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">Email</span>
                <span className="col-span-2 text-gray-900">
                  {formData.email}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">Phone</span>
                <span className="col-span-2 text-gray-900">
                  {formData.phone || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2">
                <span className="font-medium text-gray-600">Address</span>
                <span className="col-span-2 text-gray-900">
                  {formData.address || "Not provided"}
                </span>
              </div>
            </div>,
          )}

          {renderSection(
            "Professional Details",
            <div className="grid gap-2 text-sm">
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">Description</span>
                <span className="col-span-2 text-gray-900">
                  {formData.description || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">
                  Qualifications
                </span>
                <span className="col-span-2 text-gray-900">
                  {formData.qualifications || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">
                  Specialization
                </span>
                <span className="col-span-2 text-gray-900">
                  {formData.specialization || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-2">
                <span className="font-medium text-gray-600">Experience</span>
                <span className="col-span-2 text-gray-900">
                  {formData.experience || "Not provided"}
                </span>
              </div>
            </div>,
          )}

          {renderSection(
            "Domain & Tags",
            <div className="space-y-4">
              <div className="grid grid-cols-3 items-center py-2 border-b border-gray-100">
                <span className="font-medium text-gray-600">Domain</span>
                <span className="col-span-2 text-gray-900">
                  {formData.domain?.name || "Not selected"}
                </span>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700">
                  Sub-Domains
                </h4>
                {renderList(formData.subDomains, "No sub-domains selected")}
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700">Tags</h4>
                {renderList(formData.tags, "No tags selected")}
              </div>
            </div>,
          )}

          {renderSchedule()}
        </CardContent>
      </Card>
      <div className="flex justify-between pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="px-6"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          variant="night"
          className="px-6"
        >
          Submit
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
