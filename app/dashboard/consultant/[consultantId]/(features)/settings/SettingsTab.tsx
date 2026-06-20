"use client";

import * as Sentry from "@sentry/nextjs";
import { ScheduleType, SessionType } from "@prisma/client";
import { TrashIcon } from "assets/icons";
import { Button } from "components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "components/ui/dialog";
import ConsultantVerificationForm from "@/app/form/onboarding/components/ConsultantVerificationForm";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { RadioGroup, RadioGroupItem } from "components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "components/ui/select";
import { Separator } from "components/ui/separator";
import { Textarea } from "components/ui/textarea";
import { useToast } from "components/ui/use-toast";
import { Checkbox } from "components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "components/ui/alert";
import {
  XCircle,
  ChevronDown,
  ChevronUp,
  FileText,
  CheckCircle,
  Loader2,
  RefreshCw,
  Clock,
  Shield,
  Calendar,
  CalendarDays,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { TConsultantProfile } from "types/consultant";
import { MultiSelect } from "../../components/MultiSelect";
import {
  DAYS_OF_WEEK,
  getInitialCustomSlots,
  getInitialFormData,
  getInitialWeeklySlots,
  getMonthYearString,
  type Domain,
  type FormData,
  type SubDomain,
  type Tag,
} from "./settings";
import { useTimezone } from "@/app/explore/experts/[consultantId]/hooks/useTimezone";
// Import functions from centralized utils
import {
  formatDayDisplay,
  getDaysInMonth,
  getFirstDayOfMonth,
  getLocalDateString,
} from "@/utils/dateTimeUtils";
import {
  validateTimeSlot,
  validateAllSlotsDetailed,
} from "@/utils/timeSlotValidation";
// Import shared schedule components and utilities
import { SlotValidationFeedback } from "@/components/schedule/SlotValidationFeedback";
import { NotificationPreferencesPanel } from "@/components/notifications";
import { formatSlotsForApi } from "@/utils/schedule/formatting";
import type { SlotsType } from "@/utils/schedule/types";

interface Option {
  value: string;
  label: string;
}

interface SettingsTabProps {
  consultant: TConsultantProfile;
}

interface DocumentFeedback {
  id: string;
  fileName: string;
  originalName?: string;
  isValid: boolean | null;
  staffFeedback?: string | null;
}

interface VerificationDetails {
  id: string;
  status: string;
  rejectionReason?: string | null;
  feedbackDetails?: string | null;
  reviewedAt?: string;
  documents: DocumentFeedback[];
}

interface VerificationDocument {
  id?: string;
  status: string;
}

interface VerificationSubmitData {
  verificationLinkedinUrl?: string;
  verificationNotes?: string;
  verificationDocuments?: VerificationDocument[];
}

export function SettingsTab({ consultant }: Readonly<SettingsTabProps>) {
  const { toast } = useToast();
  const { timezone, isLoading: timezoneLoading } = useTimezone();
  const [isLoading, setIsLoading] = useState(false);
  const [isContentLoading, setIsContentLoading] = useState(true);
  const [weeklySlots, setWeeklySlots] = useState<SlotsType>({});
  const [customSlots, setCustomSlots] = useState<SlotsType>({});
  const [currentDate, setCurrentDate] = useState(new Date());
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    consultant.scheduleType,
  );
  const [formData, setFormData] = useState<FormData>(
    getInitialFormData(consultant),
  );
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  // Schedule type switching restriction state
  const [canSwitchSchedule, setCanSwitchSchedule] = useState(true);
  const [scheduleSwitchBlockedReason, setScheduleSwitchBlockedReason] =
    useState<string | null>(null);

  // Verification resubmission state
  const [verificationDetails, setVerificationDetails] =
    useState<VerificationDetails | null>(null);
  const [isLoadingVerification, setIsLoadingVerification] = useState(false);
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [showVerificationDetails, setShowVerificationDetails] = useState(false);

  // Initialize slots data when timezone is available
  useEffect(() => {
    if (!timezoneLoading && timezone) {
      setWeeklySlots(getInitialWeeklySlots(consultant, timezone));
      setCustomSlots(getInitialCustomSlots(consultant, timezone));
    }
  }, [consultant, timezone, timezoneLoading]);

  // Check if schedule type switching is allowed
  useEffect(() => {
    async function checkScheduleSwitchEligibility() {
      try {
        const res = await fetch(
          `/api/user/consultants/${consultant.id}/can-switch-schedule`,
        );
        const data = await res.json();
        setCanSwitchSchedule(data.canSwitch);
        if (!data.canSwitch) {
          setScheduleSwitchBlockedReason(data.details || data.reason);
        } else {
          setScheduleSwitchBlockedReason(null);
        }
      } catch (error) {
        console.error("Error checking schedule switch eligibility:", error);
        // On error, allow switching (backend will validate anyway)
        setCanSwitchSchedule(true);
      }
    }
    checkScheduleSwitchEligibility();
  }, [consultant.id]);

  // Fetch verification details when status is REJECTED AND PENDING_VERIFICATION
  useEffect(() => {
    async function fetchVerificationDetails() {
      // Fetch details if Rejected OR Pending (to show "Request Changes" feedback)
      if (
        consultant.verificationStatus !== "REJECTED" &&
        consultant.verificationStatus !== "PENDING_VERIFICATION"
      ) {
        return;
      }

      setIsLoadingVerification(true);
      try {
        const res = await fetch("/api/verification/status");
        if (res.ok) {
          const responseData = await res.json();
          if (responseData.success && responseData.data?.latestRequest) {
            const latestVerification = responseData.data.latestRequest;
            setVerificationDetails({
              id: latestVerification.id,
              status: latestVerification.status,
              rejectionReason: latestVerification.rejectionReason,
              feedbackDetails: latestVerification.feedbackDetails,
              reviewedAt: latestVerification.reviewedAt,
              documents: latestVerification.documents || [],
            });
          }
        }
      } catch (error) {
        console.error("Error fetching verification details:", error);
      } finally {
        setIsLoadingVerification(false);
      }
    }
    fetchVerificationDetails();
  }, [consultant.verificationStatus]);

  // Convert subdomains and tags to options format with safety checks
  const subDomainOptions = React.useMemo<Option[]>(() => {
    if (!subDomains || !Array.isArray(subDomains) || !formData.domainId) {
      return [];
    }
    return subDomains
      .filter((sd) => sd && sd.domainId === formData.domainId)
      .map((sd) => ({
        value: sd.id,
        label: sd.name,
      }));
  }, [subDomains, formData.domainId]);

  const tagOptions = React.useMemo<Option[]>(() => {
    if (!tags || !Array.isArray(tags) || !formData.domainId) {
      return [];
    }
    return tags
      .filter((tag) => tag && tag.domainId === formData.domainId)
      .map((tag) => ({
        value: tag.id,
        label: tag.name,
      }));
  }, [tags, formData.domainId]);

  // Fetch domains, subdomains, and tags
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsContentLoading(true);
        const [domainsRes, subDomainsRes, tagsRes] = await Promise.all([
          fetch("/api/user/content/domains"),
          fetch("/api/user/content/subdomains"),
          fetch("/api/user/content/tags"),
        ]);

        if (domainsRes.ok && subDomainsRes.ok && tagsRes.ok) {
          const [domainsData, subDomainsData, tagsData] = await Promise.all([
            domainsRes.json(),
            subDomainsRes.json(),
            tagsRes.json(),
          ]);

          setDomains(domainsData || []);
          setSubDomains(subDomainsData || []);
          setTags(tagsData || []);
        }
      } catch (error) {
        console.error("Error fetching data:", error);
        toast({
          title: "Error",
          description: "Failed to load domain data. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsContentLoading(false);
      }
    };

    fetchData();
  }, [toast]);

  // Update subdomains and tags when domain changes
  useEffect(() => {
    const fetchDomainContent = async () => {
      if (!formData.domainId) return;

      try {
        setIsContentLoading(true);
        const [subDomainsRes, tagsRes] = await Promise.all([
          fetch(`/api/user/content/subdomains?domainId=${formData.domainId}`),
          fetch(`/api/user/content/tags?domainId=${formData.domainId}`),
        ]);

        if (subDomainsRes.ok && tagsRes.ok) {
          const [subDomainsData, tagsData] = await Promise.all([
            subDomainsRes.json(),
            tagsRes.json(),
          ]);

          setSubDomains(subDomainsData || []);
          setTags(tagsData || []);
        }
      } catch (error) {
        console.error("Error fetching domain content:", error);
        toast({
          title: "Error",
          description: "Failed to load domain content. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsContentLoading(false);
      }
    };

    fetchDomainContent();
  }, [formData.domainId, toast]);

  // Handle verification resubmission
  /* New Verification Modal Logic */
  const [isVerificationModalOpen, setIsVerificationModalOpen] = useState(false);

  const handleVerificationSubmit = async (data: VerificationSubmitData) => {
    setIsResubmitting(true);
    try {
      const documentIds =
        data.verificationDocuments
          ?.filter((doc): doc is Required<VerificationDocument> => doc.status === "completed" && !!doc.id)
          .map((doc) => doc.id) || [];

      const payload = {
        linkedinUrl: data.verificationLinkedinUrl,
        notes: data.verificationNotes,
        documentIds,
      };

      const res = await fetch("/api/verification/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Failed to submit verification");
      }

      toast({
        title: "Verification Submitted",
        description: "Your profile has been submitted for review successfully.",
      });

      // Close modal and update status
      setIsVerificationModalOpen(false);

      // Ideally we should reload the consultant data here to reflect the new status immediately
      window.location.reload();
    } catch (error) {
      console.error("Error submitting verification:", error);
      toast({
        title: "Submission Failed",
        description:
          error instanceof Error
            ? error.message
            : "Failed to submit verification",
        variant: "destructive",
      });
    } finally {
      setIsResubmitting(false);
    }
  };

  const handleResubmitVerification = () => {
    // Instead of direct API call, open the modal
    setIsVerificationModalOpen(true);
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleDomainChange = useCallback((value: string, e?: Event) => {
    e?.preventDefault();
    requestAnimationFrame(() => {
      setFormData((prev) => ({
        ...prev,
        domainId: value || "",
        subDomainIds: [], // Reset subdomains when domain changes
        tagIds: [], // Reset tags when domain changes
      }));
    });
  }, []);

  const handleSubDomainChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      subDomainIds: values || [],
    }));
  }, []);

  const handleTagChange = useCallback((values: string[]) => {
    setFormData((prev) => ({
      ...prev,
      tagIds: values || [],
    }));
  }, []);

  // Update schedule type and clear irrelevant slots
  const handleScheduleTypeChange = useCallback(
    (value: string) => {
      const scheduleTypeValue = value as ScheduleType;

      // Check if trying to switch schedule type when blocked
      if (!canSwitchSchedule && scheduleTypeValue !== scheduleType) {
        toast({
          title: "Cannot Switch Schedule Type",
          description:
            scheduleSwitchBlockedReason ||
            "You have active appointments. Please complete or cancel them first.",
          variant: "destructive",
        });
        return;
      }

      React.startTransition(() => {
        setScheduleType(scheduleTypeValue);
        setFormData((prev) => ({
          ...prev,
          scheduleType: scheduleTypeValue,
        }));

        // Clear slots for the inactive schedule type to prevent corruption
        if (scheduleTypeValue === ScheduleType.WEEKLY) {
          setCustomSlots({});
        } else {
          setWeeklySlots({});
        }
      });
    },
    [canSwitchSchedule, scheduleType, scheduleSwitchBlockedReason, toast],
  );

  const handleAddSlot = useCallback(
    (day: string) => {
      React.startTransition(() => {
        const updateSlots = (prev: SlotsType) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []),
            { startTime: "", endTime: "", isValid: false },
          ],
        });

        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(updateSlots);
        } else {
          setCustomSlots(updateSlots);
        }
      });
    },
    [scheduleType],
  );

  const handleUpdateSlot = useCallback(
    (
      day: string,
      index: number,
      field: "startTime" | "endTime",
      value: string,
    ) => {
      React.startTransition(() => {
        const currentSlots =
          scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;
        const setSlots =
          scheduleType === ScheduleType.WEEKLY
            ? setWeeklySlots
            : setCustomSlots;

        // Create updated slot
        const updatedSlot = {
          ...currentSlots[day][index],
          [field]: value,
        };

        // Validate the updated slot in isolation
        const validationResult = validateTimeSlot(
          updatedSlot,
          currentSlots[day]?.filter((_, i) => i !== index) || [],
        );

        setSlots((prev) => ({
          ...prev,
          [day]: [
            ...(prev[day] || []).slice(0, index),
            validationResult,
            ...(prev[day] || []).slice(index + 1),
          ],
        }));
      });
    },
    [scheduleType, weeklySlots, customSlots],
  );

  const handleDeleteSlot = useCallback(
    (day: string, index: number) => {
      React.startTransition(() => {
        const deleteSlot = (prev: SlotsType) => {
          const updatedSlots = {
            ...prev,
            [day]: prev[day].filter((_, i) => i !== index),
          };
          if (updatedSlots[day].length === 0) {
            delete updatedSlots[day];
          }
          return updatedSlots;
        };

        if (scheduleType === ScheduleType.WEEKLY) {
          setWeeklySlots(deleteSlot);
        } else {
          setCustomSlots(deleteSlot);
        }
      });
    },
    [scheduleType],
  );

  const handlePrevMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
    );
  }, []);

  const handleNextMonth = useCallback(() => {
    setCurrentDate(
      (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
    );
  }, []);

  const renderCalendar = useCallback(() => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDayOfMonth = getFirstDayOfMonth(currentDate);
    const days = [];

    // Empty cells for days before the first day of the month
    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    // Calendar days
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      const dateString = getLocalDateString(date);
      const isSelected = customSlots[dateString] !== undefined;

      days.push(
        <button
          key={`day-${i}`}
          type="button"
          className={`p-2 rounded-full hover:bg-zinc-200
        ${isSelected ? "bg-black text-white" : ""}`}
          onClick={() => {
            React.startTransition(() => {
              setCustomSlots((prev) => {
                const newCustomSlots = { ...prev };
                if (isSelected) {
                  delete newCustomSlots[dateString];
                } else {
                  newCustomSlots[dateString] = [
                    { startTime: "", endTime: "", isValid: false },
                  ];
                }
                return newCustomSlots;
              });
            });
          }}
        >
          {i}
        </button>,
      );
    }

    return days;
  }, [currentDate, customSlots]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consultant?.id) return;

    const currentSlots =
      scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots;

    // Use improved validation with detailed feedback
    const validation = validateAllSlotsDetailed(currentSlots);
    if (!validation.isValid) {
      const errorMessage =
        validation.errors.length > 0
          ? `Please fix the following issues:\n${validation.errors.slice(0, 3).join("\n")}${validation.errors.length > 3 ? "\n...and more" : ""}`
          : "Please ensure all time slots are valid before saving.";

      toast({
        title: "Validation Error",
        description: errorMessage,
        variant: "destructive",
      });
      return;
    }

    if (!formData.domainId) {
      toast({
        title: "Validation Error",
        description: "Please select a domain before saving.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      // Only send slots for the current schedule type
      const updatedData = {
        ...formData,
        scheduleType,
        slotsOfAvailabilityWeekly:
          scheduleType === ScheduleType.WEEKLY
            ? formatSlotsForApi(weeklySlots, true, timezone || "UTC")
            : [],
        slotsOfAvailabilityCustom:
          scheduleType === ScheduleType.CUSTOM
            ? formatSlotsForApi(customSlots, false, timezone || "UTC")
            : [],
        // Include new fields
        headline: formData.headline || null,
        websiteUrl: formData.websiteUrl || null,
        twitterUrl: formData.twitterUrl || null,
        githubUrl: formData.githubUrl || null,
        linkedinUrl: formData.linkedinUrl || null, // Saved to User model
        videoIntroUrl: formData.videoIntroUrl || null,
        languages: formData.languages || [],
        toolsAndTechnologies: formData.toolsAndTechnologies || [],
        mentoringStyle: formData.mentoringStyle || null,
        sessionTypes: formData.sessionTypes || [],
      };

      const response = await fetch(`/api/user/consultants/${consultant.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updatedData),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      // Refetch the consultant data to show what was actually saved
      const updatedResponse = await fetch(
        `/api/user/consultants/${consultant.id}`,
      );
      if (updatedResponse.ok) {
        const { data: updatedConsultant } = await updatedResponse.json();

        // Update local state to match what was saved to database
        setWeeklySlots(
          getInitialWeeklySlots(updatedConsultant, timezone || "UTC"),
        );
        setCustomSlots(
          getInitialCustomSlots(updatedConsultant, timezone || "UTC"),
        );
        setFormData(getInitialFormData(updatedConsultant));
        setScheduleType(updatedConsultant.scheduleType);
      }

      toast({
        title: "Settings updated",
        description: "Your profile settings have been successfully updated.",
      });
    } catch (error) {
      console.error("Error updating settings:", error);
      toast({
        title: "Error",
        description: "Failed to update settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isContentLoading || timezoneLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-t-black border-r-black border-b-zinc-200 border-l-zinc-200 rounded-full animate-spin mb-4"></div>
          <p className="text-zinc-500">
            {timezoneLoading ? "Detecting timezone..." : "Loading settings..."}
          </p>
        </div>
      </div>
    );
  }

  // Computed values for verification display
  const invalidDocuments =
    verificationDetails?.documents?.filter((doc) => doc.isValid === false) ||
    [];
  const validDocuments =
    verificationDetails?.documents?.filter((doc) => doc.isValid === true) || [];

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white p-6 rounded-lg shadow space-y-8"
      role="form"
      aria-label="Settings form"
    >
      {/* Unified Verification Status UI */}
      {consultant.verificationStatus && (
        <div
          className={`border-2 rounded-xl p-6 mb-8 ${
            consultant.verificationStatus === "VERIFIED"
              ? "border-green-200 bg-green-50"
              : consultant.verificationStatus === "PENDING_VERIFICATION"
                ? "border-amber-200 bg-amber-50"
                : consultant.verificationStatus === "UNDER_REVIEW"
                  ? "border-blue-200 bg-blue-50"
                  : "border-red-200 bg-red-50"
          }`}
        >
          <div className="flex items-start gap-4">
            <div
              className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center ${
                consultant.verificationStatus === "VERIFIED"
                  ? "bg-green-100"
                  : consultant.verificationStatus === "PENDING_VERIFICATION"
                    ? "bg-amber-100"
                    : consultant.verificationStatus === "UNDER_REVIEW"
                      ? "bg-blue-100"
                      : "bg-red-100"
              }`}
            >
              {consultant.verificationStatus === "VERIFIED" ? (
                <CheckCircle className="w-6 h-6 text-green-600" />
              ) : consultant.verificationStatus === "PENDING_VERIFICATION" ? (
                <Clock className="w-6 h-6 text-amber-600" />
              ) : consultant.verificationStatus === "UNDER_REVIEW" ? (
                <Shield className="w-6 h-6 text-blue-600" />
              ) : (
                <XCircle className="w-6 h-6 text-red-600" />
              )}
            </div>

            <div className="flex-1">
              <h2
                className={`text-xl font-bold mb-2 ${
                  consultant.verificationStatus === "VERIFIED"
                    ? "text-green-900"
                    : consultant.verificationStatus === "PENDING_VERIFICATION"
                      ? "text-amber-900"
                      : consultant.verificationStatus === "UNDER_REVIEW"
                        ? "text-blue-900"
                        : "text-red-900"
                }`}
              >
                {consultant.verificationStatus === "VERIFIED"
                  ? "Profile Verified"
                  : consultant.verificationStatus === "PENDING_VERIFICATION"
                    ? "Verification Required"
                    : consultant.verificationStatus === "UNDER_REVIEW"
                      ? "Verification Under Review"
                      : "Verification Not Approved"}
              </h2>
              <p
                className={`text-sm mb-4 ${
                  consultant.verificationStatus === "VERIFIED"
                    ? "text-green-700"
                    : consultant.verificationStatus === "PENDING_VERIFICATION"
                      ? "text-amber-700"
                      : consultant.verificationStatus === "UNDER_REVIEW"
                        ? "text-blue-700"
                        : "text-red-700"
                }`}
              >
                {consultant.verificationStatus === "VERIFIED"
                  ? "Great job! Your profile has been verified. You are now visible in the consultant directory and can accept bookings."
                  : consultant.verificationStatus === "PENDING_VERIFICATION"
                    ? "Action is needed on your profile. Please review any feedback below, make necessary updates, and submit for verification."
                    : consultant.verificationStatus === "UNDER_REVIEW"
                      ? "Hold tight! Our team is currently reviewing your profile details and documents. This typically takes 1-2 business days."
                      : "Your profile verification was not approved. Please review the feedback below, update your profile as needed, and resubmit for review."}
              </p>

              {/* Loading State */}
              {isLoadingVerification ? (
                <div
                  className={`flex items-center gap-2 ${
                    consultant.verificationStatus === "REJECTED"
                      ? "text-red-600"
                      : "text-amber-600"
                  }`}
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading feedback...</span>
                </div>
              ) : verificationDetails ||
                consultant.verificationStatus === "REJECTED" ? (
                <>
                  {/* Reuse Existing Feedback UI Logic */}
                  {verificationDetails?.rejectionReason && (
                    <div
                      className={`border rounded-lg p-4 mb-4 ${
                        consultant.verificationStatus === "REJECTED"
                          ? "bg-red-100 border-red-200"
                          : "bg-amber-100 border-amber-200"
                      }`}
                    >
                      <p
                        className={`text-sm font-medium mb-1 ${
                          consultant.verificationStatus === "REJECTED"
                            ? "text-red-800"
                            : "text-amber-800"
                        }`}
                      >
                        {consultant.verificationStatus === "REJECTED"
                          ? "Reason for rejection:"
                          : "Changes requested:"}
                      </p>
                      <p
                        className={`text-sm ${
                          consultant.verificationStatus === "REJECTED"
                            ? "text-red-700"
                            : "text-amber-700"
                        }`}
                      >
                        {verificationDetails.rejectionReason}
                      </p>
                    </div>
                  )}

                  {/* Expandable Details - Only show if there are details */}
                  {(verificationDetails?.feedbackDetails ||
                    invalidDocuments.length > 0 ||
                    validDocuments.length > 0) && (
                    <div className="mb-4">
                      <button
                        type="button"
                        onClick={() =>
                          setShowVerificationDetails(!showVerificationDetails)
                        }
                        className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                          consultant.verificationStatus === "REJECTED"
                            ? "text-red-700 hover:text-red-900"
                            : "text-amber-700 hover:text-amber-900"
                        }`}
                      >
                        {showVerificationDetails ? (
                          <>
                            <ChevronUp className="w-4 h-4" />
                            Hide detailed feedback
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-4 h-4" />
                            View detailed feedback
                          </>
                        )}
                      </button>

                      {showVerificationDetails && (
                        <div className="mt-3 space-y-3">
                          {verificationDetails?.feedbackDetails && (
                            <div className="bg-white border border-zinc-200 rounded-lg p-4">
                              <p className="text-sm font-medium text-zinc-700 mb-2">
                                Additional feedback from reviewer:
                              </p>
                              <p className="text-sm text-zinc-600 whitespace-pre-wrap">
                                {verificationDetails.feedbackDetails}
                              </p>
                            </div>
                          )}

                          {invalidDocuments.length > 0 && (
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                              <p className="text-sm font-medium text-amber-800 mb-3">
                                Documents requiring attention:
                              </p>
                              <ul className="space-y-2">
                                {invalidDocuments.map((doc) => (
                                  <li
                                    key={doc.id}
                                    className="flex items-start gap-3 text-sm"
                                  >
                                    <FileText className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                                    <div>
                                      <p className="font-medium text-amber-900">
                                        {doc.originalName || doc.fileName}
                                      </p>
                                      {doc.staffFeedback && (
                                        <p className="text-amber-700 mt-0.5">
                                          {doc.staffFeedback}
                                        </p>
                                      )}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {validDocuments.length > 0 && (
                            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                              <p className="text-sm font-medium text-green-800 mb-2">
                                Verified documents:
                              </p>
                              <ul className="space-y-1">
                                {validDocuments.map((doc) => (
                                  <li
                                    key={doc.id}
                                    className="flex items-center gap-2 text-sm text-green-700"
                                  >
                                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                                    <span>
                                      {doc.originalName || doc.fileName}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : null}

              {/* Action Buttons */}
              {(consultant.verificationStatus === "REJECTED" ||
                consultant.verificationStatus === "PENDING_VERIFICATION") && (
                <div className="flex items-center gap-4">
                  <Button
                    type="button"
                    onClick={handleResubmitVerification}
                    disabled={isResubmitting}
                    className="gap-2"
                    variant={
                      consultant.verificationStatus === "REJECTED"
                        ? "destructive"
                        : "default"
                    }
                  >
                    {isResubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {consultant.verificationStatus === "REJECTED"
                          ? "Resubmitting..."
                          : "Submitting..."}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4" />
                        {consultant.verificationStatus === "REJECTED"
                          ? "Resubmit for Verification"
                          : "Submit for Verification"}
                      </>
                    )}
                  </Button>
                  <p
                    className={`text-xs ${
                      consultant.verificationStatus === "REJECTED"
                        ? "text-red-600"
                        : "text-amber-600"
                    }`}
                  >
                    Make sure to update your profile below before submitting
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Professional Profile */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Professional Profile</h2>
        <p className="text-sm text-zinc-600 mb-8">
          Showcase your expertise and professional background
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Core Info */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Domain Expertise
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Primary Domain
                  </Label>
                  <Select
                    value={formData.domainId || ""}
                    onValueChange={handleDomainChange}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select your primary domain" />
                    </SelectTrigger>
                    <SelectContent>
                      {(domains || [])
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((domain) => (
                          <SelectItem key={domain.id} value={domain.id}>
                            {domain.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">Sub Domains</Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={subDomainOptions}
                      selected={formData.subDomainIds || []}
                      onChange={handleSubDomainChange}
                      placeholder="Select relevant sub domains"
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Expertise Tags
                  </Label>
                  <div className="mt-1">
                    <MultiSelect
                      options={tagOptions}
                      selected={formData.tagIds || []}
                      onChange={handleTagChange}
                      placeholder="Add expertise tags"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Professional Background
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Years of Experience
                  </Label>
                  <Input
                    name="experience"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={formData.experience}
                    onChange={handleInputChange}
                    placeholder="Years of experience (e.g. 5.5)"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Description */}
          <div className="bg-zinc-50 p-6 rounded-lg h-full">
            <Label className="text-lg font-semibold mb-4 block">
              Professional Summary
            </Label>
            <p className="text-sm text-zinc-600 mb-3">
              Write a compelling description of your expertise and what makes
              you unique
            </p>
            <Textarea
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="Share your professional journey, achievements, and what clients can expect when working with you..."
              className="h-[calc(100%-6rem)] resize-none"
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Enhanced Profile Section */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Enhanced Profile</h2>
        <p className="text-sm text-zinc-600 mb-8">
          Add more details to help mentees find and connect with you
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Headlines and Bio */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Profile Highlights
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Professional Headline
                  </Label>
                  <Input
                    name="headline"
                    value={formData.headline}
                    onChange={handleInputChange}
                    placeholder="e.g., Senior Software Engineer | 10+ Years in AI/ML"
                    className="mt-1"
                    maxLength={120}
                  />
                  <p className="text-xs text-zinc-400 mt-1">
                    {formData.headline?.length || 0}/120 characters
                  </p>
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Mentoring Style
                  </Label>
                  <Textarea
                    name="mentoringStyle"
                    value={formData.mentoringStyle}
                    onChange={handleInputChange}
                    placeholder="Describe how you approach mentoring sessions (e.g., hands-on, structured, conversational...)"
                    className="mt-1 resize-none h-24"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Video Introduction URL
                  </Label>
                  <Input
                    name="videoIntroUrl"
                    value={formData.videoIntroUrl}
                    onChange={handleInputChange}
                    placeholder="https://youtube.com/watch?v=..."
                    className="mt-1"
                    type="url"
                  />
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Session Types
              </Label>
              <p className="text-sm text-zinc-600 mb-4">
                Select the types of sessions you offer
              </p>
              <div className="space-y-3">
                {Object.values(SessionType).map((type) => (
                  <div key={type} className="flex items-center space-x-3">
                    <Checkbox
                      id={`session-${type}`}
                      checked={formData.sessionTypes?.includes(type)}
                      onCheckedChange={(checked) => {
                        setFormData((prev) => ({
                          ...prev,
                          sessionTypes: checked
                            ? [...(prev.sessionTypes || []), type]
                            : (prev.sessionTypes || []).filter(
                                (t) => t !== type,
                              ),
                        }));
                      }}
                    />
                    <Label
                      htmlFor={`session-${type}`}
                      className="text-sm cursor-pointer"
                    >
                      {type === "ONE_ON_ONE" && "1:1 Sessions"}
                      {type === "GROUP" && "Group Sessions"}
                      {type === "ASYNC_REVIEW" &&
                        "Async Review (Code/Document)"}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column - Social Links and Skills */}
          <div className="space-y-6">
            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Social & Professional Links
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">Website</Label>
                  <Input
                    name="websiteUrl"
                    value={formData.websiteUrl}
                    onChange={handleInputChange}
                    placeholder="https://your-portfolio.com"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">GitHub</Label>
                  <Input
                    name="githubUrl"
                    value={formData.githubUrl}
                    onChange={handleInputChange}
                    placeholder="https://github.com/username"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">Twitter/X</Label>
                  <Input
                    name="twitterUrl"
                    value={formData.twitterUrl}
                    onChange={handleInputChange}
                    placeholder="https://twitter.com/username"
                    className="mt-1"
                    type="url"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">LinkedIn</Label>
                  <Input
                    name="linkedinUrl"
                    value={formData.linkedinUrl}
                    onChange={handleInputChange}
                    placeholder="https://linkedin.com/in/username"
                    className="mt-1"
                    type="url"
                  />
                </div>
              </div>
            </div>

            <div className="bg-zinc-50 p-6 rounded-lg">
              <Label className="text-lg font-semibold mb-4 block">
                Skills & Languages
              </Label>
              <div className="space-y-4">
                <div>
                  <Label className="text-sm text-zinc-600">
                    Languages Spoken
                  </Label>
                  <Input
                    value={(formData.languages || []).join(", ")}
                    onChange={(e) => {
                      const languages = e.target.value
                        .split(",")
                        .map((l) => l.trim())
                        .filter(Boolean);
                      setFormData((prev) => ({ ...prev, languages }));
                    }}
                    placeholder="English, Hindi, Spanish (comma-separated)"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label className="text-sm text-zinc-600">
                    Tools & Technologies
                  </Label>
                  <Input
                    value={(formData.toolsAndTechnologies || []).join(", ")}
                    onChange={(e) => {
                      const toolsAndTechnologies = e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean);
                      setFormData((prev) => ({
                        ...prev,
                        toolsAndTechnologies,
                      }));
                    }}
                    placeholder="React, Python, AWS (comma-separated)"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {/* Availability Settings */}
      <div>
        <h2 className="text-2xl font-bold mb-3">Availability Settings</h2>
        <p className="text-sm text-zinc-600 mb-8">
          Configure your availability and scheduling preferences
        </p>

        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="font-medium text-blue-900 mb-2 flex items-center">
            <Calendar className="w-4 h-4 inline mr-1" />
            Schedule Type Filtering
          </h3>
          <p className="text-sm text-blue-700">
            <strong>Important:</strong> Consultees will only see slots from your
            selected schedule type. Choose "Weekly Recurring" for regular
            appointments or "Custom Schedule" for specific dates only.
          </p>
        </div>

        {!canSwitchSchedule && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Schedule Type Locked</AlertTitle>
            <AlertDescription>
              {scheduleSwitchBlockedReason ||
                "You have active appointments that prevent schedule type changes."}{" "}
              Please complete or cancel all pending appointments before
              switching schedule types.
            </AlertDescription>
          </Alert>
        )}

        <RadioGroup
          value={scheduleType}
          onValueChange={handleScheduleTypeChange}
          className="flex flex-col md:flex-row md:space-x-8 space-y-4 md:space-y-0"
        >
          {/* Weekly Schedule */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor="WEEKLY" className="font-medium flex items-center">
                <Calendar className="w-4 h-4 mr-1" />
                Weekly Recurring
                <span className="ml-2 text-xs text-zinc-500">
                  (Shows recurring slots)
                </span>
              </Label>
              <RadioGroupItem id="WEEKLY" value={ScheduleType.WEEKLY} />
            </div>
            {(
              <div className={`space-y-4 transition-opacity ${scheduleType !== ScheduleType.WEEKLY ? "opacity-40 pointer-events-none" : ""}`}>
                {DAYS_OF_WEEK.map((day) => (
                  <div key={day} className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label>{formatDayDisplay(day)}</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddSlot(day.toLowerCase())}
                      >
                        Add Slot
                      </Button>
                    </div>
                    {weeklySlots[day.toLowerCase()]?.map((slot, slotIndex) => (
                      <div key={`${day}-${slotIndex}`} className="space-y-2">
                        <div className="grid grid-cols-7 gap-2 items-center">
                          <Input
                            type="time"
                            value={slot.startTime}
                            onChange={(e) =>
                              handleUpdateSlot(
                                day.toLowerCase(),
                                slotIndex,
                                "startTime",
                                e.target.value,
                              )
                            }
                            className={`col-span-3 ${!slot.isValid ? "border-red-500" : ""}`}
                            step="900"
                          />
                          <span className="text-center">to</span>
                          <Input
                            type="time"
                            value={slot.endTime}
                            onChange={(e) =>
                              handleUpdateSlot(
                                day.toLowerCase(),
                                slotIndex,
                                "endTime",
                                e.target.value,
                              )
                            }
                            className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                            step="900"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              handleDeleteSlot(day.toLowerCase(), slotIndex)
                            }
                            className="p-1 hover:bg-zinc-100 rounded"
                            aria-label={`Delete slot ${slotIndex + 1} for ${day}`}
                          >
                            <TrashIcon className="w-5 h-5" />
                          </button>
                        </div>
                        {!slot.isValid && slot.errorMessage && (
                          <p className="text-red-500 text-sm">
                            {slot.errorMessage}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Custom Schedule */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor="CUSTOM" className="font-medium flex items-center">
                <CalendarDays className="w-4 h-4 mr-1" />
                Custom Schedule
                <span className="ml-2 text-xs text-zinc-500">
                  (Shows specific date slots)
                </span>
              </Label>
              <RadioGroupItem id="CUSTOM" value={ScheduleType.CUSTOM} />
            </div>
            {(
              <div className={`space-y-4 transition-opacity ${scheduleType !== ScheduleType.CUSTOM ? "opacity-40 pointer-events-none" : ""}`}>
                <div className="calendar-container bg-white border p-4 rounded-lg">
                <div className="flex justify-between items-center mb-4">
                  <button
                    type="button"
                    className="text-black hover:bg-zinc-100 p-2 rounded-full"
                    onClick={handlePrevMonth}
                    aria-label="Previous month"
                  >
                    &larr;
                  </button>
                  <span className="font-medium">
                    {getMonthYearString(currentDate)}
                  </span>
                  <button
                    type="button"
                    className="text-black hover:bg-zinc-100 p-2 rounded-full"
                    onClick={handleNextMonth}
                    aria-label="Next month"
                  >
                    &rarr;
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                    <div key={day} className="text-sm font-medium">
                      {day}
                    </div>
                  ))}
                  {renderCalendar()}
                </div>
              </div>

              {Object.keys(customSlots)
                .sort((a, b) => a.localeCompare(b))
                .map((dateString) => {
                  const date = new Date(dateString);
                  return (
                    <div key={dateString} className="space-y-2">
                      <div className="flex justify-between items-center">
                        <h4 className="font-semibold">
                          {date.toLocaleDateString("en-US", {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                          })}
                        </h4>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddSlot(dateString)}
                        >
                          Add Slot
                        </Button>
                      </div>
                      {customSlots[dateString]?.map((slot, slotIndex) => (
                        <div
                          key={`${dateString}-${slotIndex}`}
                          className="space-y-2"
                        >
                          <div className="grid grid-cols-7 gap-2 items-center">
                            <Input
                              type="time"
                              value={slot.startTime}
                              onChange={(e) =>
                                handleUpdateSlot(
                                  dateString,
                                  slotIndex,
                                  "startTime",
                                  e.target.value,
                                )
                              }
                              className={`col-span-3 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <span className="text-center">to</span>
                            <Input
                              type="time"
                              value={slot.endTime}
                              onChange={(e) =>
                                handleUpdateSlot(
                                  dateString,
                                  slotIndex,
                                  "endTime",
                                  e.target.value,
                                )
                              }
                              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
                              step="900"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                handleDeleteSlot(dateString, slotIndex)
                              }
                              className="p-1 hover:bg-zinc-100 rounded"
                              aria-label={`Delete slot ${slotIndex + 1} for ${dateString}`}
                            >
                              <TrashIcon className="w-5 h-5" />
                            </button>
                          </div>
                          {!slot.isValid && slot.errorMessage && (
                            <p className="text-red-500 text-sm">
                              {slot.errorMessage}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </RadioGroup>
      </div>

      {/* Slot Validation Feedback - shared component */}
      <SlotValidationFeedback
        slots={scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots}
        className="mt-4"
      />

      <Separator />

      {/* Notification Preferences */}
      <NotificationPreferencesPanel />

      {/* Action Buttons */}
      <div className="flex justify-end items-center space-x-4 pt-6">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            React.startTransition(() => {
              setFormData(getInitialFormData(consultant));
              setScheduleType(consultant.scheduleType);
              setWeeklySlots(
                getInitialWeeklySlots(consultant, timezone || "UTC"),
              );
              setCustomSlots(
                getInitialCustomSlots(consultant, timezone || "UTC"),
              );
            });
          }}
          disabled={isLoading}
        >
          Reset
        </Button>
        <Button
          type="submit"
          className="bg-primary hover:bg-primary/90 text-primary-foreground min-w-[200px]"
          disabled={isLoading}
        >
          {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Save Changes
        </Button>
      </div>

      {/* Verification Resubmission Modal */}
      <Dialog
        open={isVerificationModalOpen}
        onOpenChange={setIsVerificationModalOpen}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <DialogHeader>
            <DialogTitle>Verification Details</DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <ConsultantVerificationForm
              onNext={handleVerificationSubmit}
              onBack={() => setIsVerificationModalOpen(false)}
              initialData={{
                verificationLinkedinUrl: consultant.user.linkedinUrl || "",
                verificationNotes: verificationDetails?.rejectionReason
                  ? `Regarding your feedback: `
                  : "",
                // Note: We can't easily pre-fill documents as UploadedDocument type differs from Prisma model
                // But user can upload new ones.
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
