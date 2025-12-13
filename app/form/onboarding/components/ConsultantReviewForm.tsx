import { Button } from "@/components/ui/button";
import { formatDate, formatTime } from "@/utils/dateTimeUtils";
import { OnboardingFormData } from "@/utils/onboarding";
import React from "react";

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
    availabilityStartsAt: string;
    availabilityEndsAt: string;
  }): boolean => {
    const startTime = formatTime(slot.availabilityStartsAt, "12h");
    const endTime = formatTime(slot.availabilityEndsAt, "12h");
    return startTime !== endTime;
  };

  const renderSchedule = () => {
    if (!formData.scheduleType) return null;

    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Schedule
        </h3>
        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <div className="flex justify-between py-2 border-b">
            <span className="text-sm text-muted-foreground">Schedule Type</span>
            <span className="text-sm font-medium">{formData.scheduleType}</span>
          </div>

          {formData.scheduleType === "WEEKLY" && formData.weeklySlots && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Weekly Slots</p>
              <div className="space-y-1">
                {formData.weeklySlots.filter(isValidSlot).map((slot, index) => {
                  const startTime = formatTime(slot.availabilityStartsAt, "12h");
                  const endTime = formatTime(slot.availabilityEndsAt, "12h");
                  const isSameDay =
                    slot.dayOfWeekForStartsAt === slot.dayOfWeekForEndsAt;

                  return (
                    <div
                      key={index}
                      className="px-3 py-2 bg-background border rounded-lg text-sm"
                    >
                      <span className="font-medium">
                        {slot.dayOfWeekForStartsAt}
                      </span>{" "}
                      <span className="text-muted-foreground">{startTime}</span>
                      {" to "}
                      {!isSameDay && (
                        <span className="font-medium">
                          {slot.dayOfWeekForEndsAt}{" "}
                        </span>
                      )}
                      <span className="text-muted-foreground">{endTime}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {formData.scheduleType === "CUSTOM" && formData.customSlots && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Custom Slots</p>
              <div className="space-y-1">
                {formData.customSlots.filter(isValidSlot).map((slot, index) => {
                  const startDate = formatDate(slot.availabilityStartsAt);
                  const endDate = formatDate(slot.availabilityEndsAt);
                  const startTime = formatTime(slot.availabilityStartsAt, "12h");
                  const endTime = formatTime(slot.availabilityEndsAt, "12h");
                  const isSameDay = startDate === endDate;

                  return (
                    <div
                      key={index}
                      className="px-3 py-2 bg-background border rounded-lg text-sm"
                    >
                      <span className="font-medium">{startDate}</span>{" "}
                      <span className="text-muted-foreground">{startTime}</span>
                      {" to "}
                      {!isSameDay && (
                        <span className="font-medium">{endDate} </span>
                      )}
                      <span className="text-muted-foreground">{endTime}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSection = (title: string, content: React.ReactNode) => (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      {content}
    </div>
  );

  const renderField = (label: string, value: string | number | undefined) => (
    <div className="flex justify-between py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm">{value || "Not provided"}</span>
    </div>
  );

  const renderList = (
    items: { id: string; name: string }[] | undefined,
    emptyMessage: string
  ) => (
    <div className="flex flex-wrap gap-2">
      {items?.map((item) => (
        <span
          key={item.id}
          className="px-2 py-1 bg-primary/10 text-primary rounded text-sm"
        >
          {item.name}
        </span>
      ))}
      {(!items || items.length === 0) && (
        <span className="text-sm text-muted-foreground italic">{emptyMessage}</span>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {renderSection(
        "Personal Information",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Name", formData.name)}
          {renderField("Email", formData.email)}
          {renderField("Phone", formData.phone)}
          {renderField("City", formData.city)}
          {renderField("Country", formData.country)}
        </div>
      )}

      {renderSection(
        "Professional Details",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Description", formData.description)}
          {renderField("Qualifications", formData.qualifications)}
          {renderField("Specialization", formData.specialization)}
          {renderField("Experience", formData.experience ? `${formData.experience} years` : undefined)}
        </div>
      )}

      {renderSection(
        "Domain & Tags",
        <div className="bg-muted/50 rounded-lg p-4 space-y-4">
          {renderField("Domain", formData.domain?.name)}
          <div>
            <p className="text-sm text-muted-foreground mb-2">Sub-Domains</p>
            {renderList(formData.subDomains, "No sub-domains selected")}
          </div>
          <div>
            <p className="text-sm text-muted-foreground mb-2">Tags</p>
            {renderList(formData.tags, "No tags selected")}
          </div>
        </div>
      )}

      {renderSchedule()}

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button type="button" onClick={handleSubmit} className="flex-1">
          Complete Registration
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
