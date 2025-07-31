import { Button } from "@/components/ui/button";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import {
  ConsultantProfile,
  PersonalInfoAndRole,
  PreferredSchedule,
} from "@/schemas/user";
import { formatDate, formatTime } from "@/utils/dateTimeUtils";
import React from "react";
import { useThemeClasses } from "../useTheme";

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
  const { classes, colors } = useThemeClasses();
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
        <h3 className="text-lg font-semibold text-white">Schedule</h3>
        <p className="text-sm text-white/70">
          Schedule Type:{" "}
          <span className="font-medium text-white">
            {formData.scheduleType}
          </span>
        </p>
        {formData.scheduleType === "WEEKLY" && formData.weeklySlots && (
          <div className="space-y-2">
            <h4 className="text-md font-medium text-white">Weekly Slots</h4>
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
                    className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white"
                  >
                    <span className="font-medium">
                      {slot.dayOfWeekforStartTimeInUTC}
                    </span>{" "}
                    <span className="text-white/70">{startTime}</span>
                    {" to "}
                    {!isSameDay && (
                      <span className="font-medium">
                        {slot.dayOfWeekforEndTimeInUTC}{" "}
                      </span>
                    )}
                    <span className="text-white/70">{endTime}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {formData.scheduleType === "CUSTOM" && formData.customSlots && (
          <div className="space-y-2">
            <h4 className="text-md font-medium text-white">Custom Slots</h4>
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
                    className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white"
                  >
                    <span className="font-medium">{startDate}</span>{" "}
                    <span className="text-white/70">{startTime}</span>
                    {" to "}
                    {!isSameDay && (
                      <span className="font-medium">{endDate} </span>
                    )}
                    <span className="text-white/70">{endTime}</span>
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
      <h3 className="text-lg font-semibold text-white">{title}</h3>
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
          className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-md text-sm text-white"
        >
          {item.name}
        </li>
      ))}
      {(!items || items.length === 0) && (
        <li className="text-sm text-white/50 italic">{emptyMessage}</li>
      )}
    </ul>
  );

  return (
    <div className="w-full space-y-6">
      <div
        className={`glassmorphism2 rounded-2xl p-6 ${colors.glassBorder} shadow-2xl`}
      >
        <div className="mb-6">
          <h3 className={`text-2xl font-bold ${colors.textPrimary} mb-2`}>
            Review Your Information
          </h3>
          <p className={colors.textSecondary}>
            Please review your details before submitting
          </p>
        </div>
        <div className="space-y-6">
          {renderSection(
            "Personal Information",
            <div className="grid gap-2 text-sm">
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">Name</span>
                <span className="col-span-2 text-white">{formData.name}</span>
              </div>
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">Email</span>
                <span className="col-span-2 text-white">{formData.email}</span>
              </div>
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">Phone</span>
                <span className="col-span-2 text-white">
                  {formData.phone || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-3">
                <span className="font-medium text-white/70">Address</span>
                <span className="col-span-2 text-white">
                  {formData.address || "Not provided"}
                </span>
              </div>
            </div>,
          )}

          {renderSection(
            "Professional Details",
            <div className="grid gap-2 text-sm">
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">Description</span>
                <span className="col-span-2 text-white">
                  {formData.description || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">
                  Qualifications
                </span>
                <span className="col-span-2 text-white">
                  {formData.qualifications || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">
                  Specialization
                </span>
                <span className="col-span-2 text-white">
                  {formData.specialization || "Not provided"}
                </span>
              </div>
              <div className="grid grid-cols-3 items-center py-3">
                <span className="font-medium text-white/70">Experience</span>
                <span className="col-span-2 text-white">
                  {formData.experience || "Not provided"}
                </span>
              </div>
            </div>,
          )}

          {renderSection(
            "Domain & Tags",
            <div className="space-y-4">
              <div className="grid grid-cols-3 items-center py-3 border-b border-white/10">
                <span className="font-medium text-white/70">Domain</span>
                <span className="col-span-2 text-white">
                  {formData.domain?.name || "Not selected"}
                </span>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-white">Sub-Domains</h4>
                {renderList(formData.subDomains, "No sub-domains selected")}
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-white">Tags</h4>
                {renderList(formData.tags, "No tags selected")}
              </div>
            </div>,
          )}

          {renderSchedule()}
        </div>
      </div>
      <div className="flex justify-between gap-4">
        <Button
          type="button"
          onClick={onBack}
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          className={`flex-1 h-12 ${classes.primaryButton}`}
        >
          Complete Onboarding ✓
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
