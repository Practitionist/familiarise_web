import { Button } from "@/components/ui/button";
import { formatDate, formatTime } from "@/utils/dateTimeUtils";
import { minutesToTimeString } from "@/utils/slotAllocation/slotTimeUtils";
import { OnboardingFormData } from "@/utils/onboarding";
import React, { useState } from "react";
import {
  Briefcase,
  GraduationCap,
  Award,
  Shield,
  ExternalLink,
  Loader2,
} from "lucide-react";

interface Props {
  onSubmit: (data: Partial<OnboardingFormData>) => void | Promise<void>;
  onBack: () => void;
  formData: Partial<OnboardingFormData>;
}

const ConsultantReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    onSubmit(formData);
  };

  const isValidWeeklySlot = (slot: {
    startTimeUtc: number;
    endTimeUtc: number;
  }): boolean => {
    return slot.startTimeUtc !== slot.endTimeUtc;
  };

  const isValidCustomSlot = (slot: {
    startsAt: string;
    endsAt: string;
  }): boolean => {
    const startTime = formatTime(slot.startsAt, "12h");
    const endTime = formatTime(slot.endsAt, "12h");
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
                {formData.weeklySlots
                  .filter(isValidWeeklySlot)
                  .map((slot, index) => {
                    const startTime = minutesToTimeString(slot.startTimeUtc);
                    const endTime = minutesToTimeString(slot.endTimeUtc);
                    const isSameDay = slot.startDay === slot.endDay;

                    return (
                      <div
                        key={index}
                        className="px-3 py-2 bg-background border rounded-lg text-sm"
                      >
                        <span className="font-medium">{slot.startDay}</span>{" "}
                        <span className="text-muted-foreground">
                          {startTime}
                        </span>
                        {" to "}
                        {!isSameDay && (
                          <span className="font-medium">{slot.endDay} </span>
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
                {formData.customSlots
                  .filter(isValidCustomSlot)
                  .map((slot, index) => {
                    const startDate = formatDate(slot.startsAt);
                    const endDate = formatDate(slot.endsAt);
                    const startTime = formatTime(slot.startsAt, "12h");
                    const endTime = formatTime(slot.endsAt, "12h");
                    const isSameDay = startDate === endDate;

                    return (
                      <div
                        key={index}
                        className="px-3 py-2 bg-background border rounded-lg text-sm"
                      >
                        <span className="font-medium">{startDate}</span>{" "}
                        <span className="text-muted-foreground">
                          {startTime}
                        </span>
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
    emptyMessage: string,
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
        <span className="text-sm text-muted-foreground italic">
          {emptyMessage}
        </span>
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
        </div>,
      )}

      {renderSection(
        "Professional Details",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Description", formData.description)}
          {renderField("Headline", formData.headline)}
          {renderField(
            "Experience",
            formData.experience ? `${formData.experience} years` : undefined,
          )}
        </div>,
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
        </div>,
      )}

      {renderSchedule()}

      {/* Professional Background */}
      {(formData.workExperiences?.length ||
        formData.educationHistory?.length ||
        formData.certificationsList?.length) && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Professional Background
          </h3>

          {/* Work Experience */}
          {formData.workExperiences && formData.workExperiences.length > 0 && (
            <div className="bg-muted/50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Briefcase className="h-4 w-4" />
                Work Experience
              </div>
              {formData.workExperiences.map((exp, index) => (
                <div
                  key={index}
                  className="px-3 py-2 bg-background border rounded-lg text-sm"
                >
                  <p className="font-medium">{exp.title}</p>
                  <p className="text-muted-foreground">
                    {exp.company}
                    {exp.location && ` • ${exp.location}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(exp.startDate).getFullYear()} -{" "}
                    {exp.isCurrent
                      ? "Present"
                      : exp.endDate
                        ? new Date(exp.endDate).getFullYear()
                        : ""}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Education */}
          {formData.educationHistory &&
            formData.educationHistory.length > 0 && (
              <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <GraduationCap className="h-4 w-4" />
                  Education
                </div>
                {formData.educationHistory.map((edu, index) => (
                  <div
                    key={index}
                    className="px-3 py-2 bg-background border rounded-lg text-sm"
                  >
                    <p className="font-medium">{edu.degree}</p>
                    <p className="text-muted-foreground">
                      {edu.institution}
                      {edu.fieldOfStudy && ` • ${edu.fieldOfStudy}`}
                    </p>
                    {(edu.startYear || edu.endYear) && (
                      <p className="text-xs text-muted-foreground">
                        {edu.startYear || ""} - {edu.endYear || ""}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

          {/* Certifications */}
          {formData.certificationsList &&
            formData.certificationsList.length > 0 && (
              <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Award className="h-4 w-4" />
                  Certifications
                </div>
                {formData.certificationsList.map((cert, index) => (
                  <div
                    key={index}
                    className="px-3 py-2 bg-background border rounded-lg text-sm"
                  >
                    <p className="font-medium">{cert.name}</p>
                    <p className="text-muted-foreground">
                      {cert.issuingOrganization}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Issued{" "}
                      {new Date(cert.issueDate).toLocaleDateString("en-US", {
                        month: "short",
                        year: "numeric",
                      })}
                      {cert.expiryDate &&
                        ` • Expires ${new Date(cert.expiryDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Verification */}
      {(formData.verificationLinkedinUrl ||
        (formData.verificationDocuments &&
          formData.verificationDocuments.length > 0)) && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Verification
          </h3>
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Shield className="h-4 w-4" />
              Verification Details
            </div>
            {formData.verificationLinkedinUrl && (
              <div className="flex justify-between py-2 border-b">
                <span className="text-sm text-muted-foreground">
                  LinkedIn Profile
                </span>
                <a
                  href={formData.verificationLinkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary flex items-center gap-1 hover:underline"
                >
                  View Profile <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {formData.verificationDocuments &&
              formData.verificationDocuments.length > 0 && (
                <div className="flex justify-between py-2">
                  <span className="text-sm text-muted-foreground">
                    Documents Uploaded
                  </span>
                  <span className="text-sm">
                    {formData.verificationDocuments.length} file(s)
                  </span>
                </div>
              )}
            {formData.verificationNotes && (
              <div className="py-2">
                <span className="text-sm text-muted-foreground block mb-1">
                  Additional Notes
                </span>
                <p className="text-sm">{formData.verificationNotes}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
          disabled={isSubmitting}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          className="flex-1"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting...
            </>
          ) : (
            "Complete Registration"
          )}
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
