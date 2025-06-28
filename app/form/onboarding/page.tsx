"use client";
import { updateOnboardingInformationAction } from "@/actions/forms/onboarding.action";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import {
  ConsultantProfile,
  ConsulteeProfile,
  PersonalInfoAndRole,
  PersonalInfoAndRoleSchema,
  PreferredSchedule,
  StaffProfile,
} from "@/schemas/user";
import { zodResolver } from "@hookform/resolvers/zod";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import ConsultantAgreementForm from "./components/ConsultantAgreementForm";
import ConsultantPreferredScheduleForm from "./components/ConsultantPreferredScheduleForm";
import ConsultantProfileForm from "./components/ConsultantProfileForm";
import ConsultantReviewForm from "./components/ConsultantReviewForm";
import ConsulteeAgreementForm from "./components/ConsulteeAgreementForm";
import ConsulteePreferencesForm from "./components/ConsulteePreferencesForm";
import ConsulteeProfileForm from "./components/ConsulteeProfileForm";
import ConsulteeReviewForm from "./components/ConsulteeReviewForm";
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";
import StaffAgreementForm from "./components/StaffAgreementForm";
import StaffProfileForm from "./components/StaffProfileForm";
import StaffResponsibilitiesForm from "./components/StaffResponsibilitiesForm";
import StaffReviewForm from "./components/StaffReviewForm";
import { ThemeName } from "./themes";
import { getOccasionTheme } from "./themeUtils";
import { useThemeClasses } from "./useTheme";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsultantProfile> &
  Partial<ConsulteeProfile> &
  Partial<StaffProfile> &
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
    interests?: string[];
    goals?: string[];
  };

const MultiStepForm: React.FC = () => {
  const { data: session, update: updateSession } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<OnboardingFormData>({
    preferredCommunicationMethod: "VIDEO",
  } as OnboardingFormData);
  const router = useRouter();
  const { toast } = useToast();

  // Theme configuration - auto-detects festivals or use default ShadCN style
  const currentTheme: ThemeName = getOccasionTheme(); // Auto-detect or default to ShadCN theme
  const { theme, classes, colors } = useThemeClasses(currentTheme);

  const methods = useForm<OnboardingFormData>({
    resolver: zodResolver(PersonalInfoAndRoleSchema),
    defaultValues: {
      preferredCommunicationMethod: "VIDEO",
    } as OnboardingFormData,
  });

  const handleNext = (stepData: Partial<OnboardingFormData>) => {
    setFormData((prevData) => {
      const updatedData = {
        ...prevData,
        ...stepData,
        preferredCommunicationMethod:
          stepData.preferredCommunicationMethod ??
          prevData.preferredCommunicationMethod ??
          "VIDEO",
      };

      if (stepData.scheduleType) {
        updatedData.scheduleType = stepData.scheduleType;
        if (stepData.weeklySlots) {
          updatedData.weeklySlots = [...stepData.weeklySlots];
        }
        if (stepData.customSlots) {
          updatedData.customSlots = [...stepData.customSlots];
        }
      }

      return updatedData;
    });
    setStep((prevStep) => prevStep + 1);
  };

  const handleBack = () => {
    setStep((prevStep) => prevStep - 1);
  };

  const handleSubmit = async (data: OnboardingFormData) => {
    const finalData = { ...formData, ...data };
    console.log("Finally Submitted Data:", finalData);

    try {
      const id = session?.user?.id;
      if (!id) {
        throw new Error("User ID not found in session");
      }

      const formattedCustomSlots = finalData.customSlots?.map(
        (slot: { slotStartTimeInUTC: string; slotEndTimeInUTC: string }) => ({
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC).toISOString(),
          slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC).toISOString(),
        }),
      );

      const requestBody: Parameters<
        typeof updateOnboardingInformationAction
      >[1] = {
        name: finalData.name,
        email: finalData.email,
        phone: finalData.phone,
        address: finalData.address,
        currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        role: finalData.role,
        consultantProfile:
          finalData.role === "CONSULTANT"
            ? {
                create: {
                  description: finalData.description ?? "",
                  qualifications: finalData.qualifications ?? "",
                  specialization: finalData.specialization ?? "",
                  experience: finalData.experience ?? null,
                  domain: { connect: { id: finalData.domain!.id } },
                  subDomains: finalData.subDomains?.filter(
                    (sd) => sd.id !== undefined && sd.id !== null,
                  ).length
                    ? {
                        connect: finalData.subDomains
                          .filter((sd) => sd.id !== undefined && sd.id !== null)
                          .map((sd: SubDomain) => ({
                            id: sd.id!,
                          })),
                      }
                    : undefined,
                  tags: finalData.tags?.filter(
                    (t) => t.id !== undefined && t.id !== null,
                  ).length
                    ? {
                        connect: finalData.tags
                          .filter((t) => t.id !== undefined && t.id !== null)
                          .map((t: Tag) => ({ id: t.id! })),
                      }
                    : undefined,
                  scheduleType: finalData.scheduleType ?? "WEEKLY",
                  slotsOfAvailabilityWeekly: finalData.weeklySlots?.length
                    ? {
                        create: finalData.weeklySlots.map((slot) => ({
                          dayOfWeekforStartTimeInUTC:
                            slot.dayOfWeekforStartTimeInUTC,
                          slotStartTimeInUTC: slot.slotStartTimeInUTC,
                          dayOfWeekforEndTimeInUTC:
                            slot.dayOfWeekforEndTimeInUTC,
                          slotEndTimeInUTC: slot.slotEndTimeInUTC,
                        })),
                      }
                    : undefined,
                  slotsOfAvailabilityCustom: formattedCustomSlots?.length
                    ? {
                        create: formattedCustomSlots,
                      }
                    : undefined,
                },
              }
            : undefined,
        consulteeProfile:
          finalData.role === "CONSULTEE"
            ? {
                create: {
                  education: finalData.education ?? "",
                  occupation: finalData.occupation ?? "",
                  aboutMe: finalData.aboutMe ?? "",
                  preferredCommunicationMethod:
                    finalData.preferredCommunicationMethod ?? "VIDEO",
                  preferredLanguage: finalData.preferredLanguage ?? "",
                  specialRequirements: finalData.specialRequirements ?? "",
                  interests: finalData.interests ?? [],
                  goals: finalData.goals ?? [],
                },
              }
            : undefined,
        staffProfile:
          finalData.role === "STAFF"
            ? {
                create: {
                  department: finalData.department ?? "",
                  position: finalData.position ?? "",
                  permissions: finalData.permissions ?? {},
                  responsibilities: finalData.responsibilities ?? {},
                },
              }
            : undefined,
      };

      console.log(
        "Request Body for Action:",
        JSON.stringify(requestBody, null, 2),
      );
      toast({
        title: "Updating Onboarding Information",
        description: "Please wait...",
        variant: "default",
      });

      const result = await updateOnboardingInformationAction(id, requestBody);

      if (!result.success || !result.user) {
        const errorMessage =
          result.error ?? "Failed to update onboarding information";

        if (errorMessage.includes("User not found")) {
          toast({
            title: "User Not Found",
            description: "Please sign out and sign in again.",
            variant: "destructive",
          });
          signOut();
          return;
        }

        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Onboarding Completed",
        description:
          "Your onboarding information has been updated successfully.",
        variant: "default",
      });

      await updateSession({
        ...session,
        user: {
          ...session?.user,
          onboardingCompleted: true,
          role: finalData.role,
          consultantProfileId: result.user.consultantProfileId,
          consulteeProfileId: result.user.consulteeProfileId,
          staffProfileId: result.user.staffProfileId,
        },
      });

      if (finalData.role === "CONSULTANT" && result.user.consultantProfileId) {
        router.push(`/dashboard/consultant/${result.user.consultantProfileId}`);
      } else if (
        finalData.role === "CONSULTEE" &&
        result.user.consulteeProfileId
      ) {
        router.push(`/dashboard/consultee/${result.user.consulteeProfileId}`);
      } else if (finalData.role === "STAFF" && result.user.staffProfileId) {
        router.push(`/dashboard/staff/${result.user.staffProfileId}`);
      } else {
        router.push("/dashboard");
      }
    } catch (error: unknown) {
      console.error("Error updating onboarding information:", error);
      if (error instanceof Error) {
        if (error.message === "User ID not found in session") {
          toast({
            title: "User ID Not Found",
            description: "Please sign out and sign in again.",
            variant: "destructive",
          });
          signOut();
          return;
        }
      }
      toast({
        title: "Something went wrong. Please try again later.",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while updating onboarding information",
        variant: "destructive",
      });
    }
  };

  const renderFormStep = () => {
    switch (step) {
      case 0:
        return (
          <PersonalInfoAndRoleForm onNext={handleNext} initialData={formData} />
        );
      case 1:
        switch (formData.role) {
          case "CONSULTANT":
            return (
              <ConsultantProfileForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteeProfileForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "STAFF":
            return (
              <StaffProfileForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          default:
            return null;
        }
      case 2:
        switch (formData.role) {
          case "CONSULTANT":
            return (
              <ConsultantPreferredScheduleForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteePreferencesForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "STAFF":
            return (
              <StaffResponsibilitiesForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          default:
            return null;
        }
      case 3:
        switch (formData.role) {
          case "CONSULTANT":
            return (
              <ConsultantAgreementForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteeAgreementForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData}
              />
            );
          case "STAFF":
            return (
              <StaffAgreementForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
              />
            );
          default:
            return null;
        }
      case 4:
        switch (formData.role) {
          case "CONSULTANT":
            return (
              <ConsultantReviewForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteeReviewForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData}
              />
            );
          case "STAFF":
            return (
              <StaffReviewForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData}
              />
            );
          default:
            return null;
        }
      default:
        return null;
    }
  };

  return (
    <FormProvider {...methods}>
      <div className="relative flex flex-col items-center justify-center min-h-screen overflow-hidden">
        {/* Background with gradient and animated blobs */}
        <div className={`absolute inset-0 ${colors.backgroundGradient}`}>
          <div
            className={`absolute -top-40 -right-40 w-80 h-80 ${colors.blob1} rounded-full opacity-30 animate-blob`}
          ></div>
          <div
            className={`absolute -bottom-40 -left-40 w-80 h-80 ${colors.blob2} rounded-full opacity-30 animate-blob animation-delay-2000`}
          ></div>
          <div
            className={`absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-60 h-60 ${colors.blob3} rounded-full opacity-20 animate-blob animation-delay-4000`}
          ></div>
        </div>

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center w-full max-w-7xl px-6">
          <Header />
          <div
            className={`glassmorphism rounded-2xl p-8 w-full max-w-5xl ${colors.glassBorder} shadow-2xl`}
          >
            <Progress
              value={((step + 1) / 4) * 100}
              className={`w-full mb-8 h-2 ${colors.glassBg}`}
            />
            <WelcomeMessage />
            {renderFormStep()}
          </div>
        </div>
      </div>
    </FormProvider>
  );
};

const Header: React.FC = () => {
  const { colors } = useThemeClasses();
  return (
    <header className="flex items-center space-x-3 mb-8">
      <div className={`p-2 rounded-xl ${colors.primaryGradient} shadow-lg`}>
        <LogInIcon className={`w-8 h-8 ${colors.textPrimary}`} />
      </div>
      <h1 className={`text-3xl font-bold ${colors.textPrimary}`}>
        Familiarise
      </h1>
    </header>
  );
};

const WelcomeMessage: React.FC = () => {
  const { colors } = useThemeClasses();
  return (
    <div className="text-center mb-8">
      <h2 className={`text-2xl font-bold ${colors.textPrimary} mb-2`}>
        Welcome! First things first...
      </h2>
      <p className={colors.textSecondary}>You can always change them later.</p>
    </div>
  );
};

function LogInIcon(props: Readonly<React.SVGProps<SVGSVGElement>>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" x2="3" y1="12" y2="12" />
    </svg>
  );
}

export default MultiStepForm;
