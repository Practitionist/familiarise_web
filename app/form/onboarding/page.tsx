"use client";
import {
  ConsultantProfile,
  ConsulteeProfile,
  PersonalInfoAndRole,
  PersonalInfoAndRoleSchema,
  PreferredSchedule,
  StaffProfile,
} from "@/schemas/UserSchema";
import { Domain, SubDomain, Tag } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import ProgressIndicator from "../consultant/plans/components/ui/ProgressIndicator";
import ConsultantAgreementForm from "./components/ConsultantAgreementForm";
import ConsultantPreferredScheduleForm from "./components/ConsultantPreferredScheduleForm";
import ConsultantProfileForm from "./components/ConsultantProfileForm";
import ConsultantReviewForm from "./components/ConsultantReviewForm";
import ConsulteeAgreementForm from "./components/ConsulteeAgreementForm";
import ConsulteeProfileForm from "./components/ConsulteeProfileForm";
import ConsulteeReviewForm from "./components/ConsulteeReviewForm";
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";
import StaffAgreementForm from "./components/StaffAgreementForm";
import StaffProfileForm from "./components/StaffProfileForm";
import StaffResponsibilitiesForm from "./components/StaffResponsibilitiesForm";
import StaffReviewForm from "./components/StaffReviewForm";
import ConsulteePreferencesForm from "./components/ConsulteePreferencesForm";
import { useToast } from "@/hooks/use-toast";

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
  const {toast} = useToast();

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
          stepData.preferredCommunicationMethod ||
          prevData.preferredCommunicationMethod ||
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

      const requestBody = {
        name: finalData.name,
        email: finalData.email,
        phone: finalData.phone,
        address: finalData.address,
        currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        role: finalData.role,
        onboardingCompleted: true,
        consultantProfile:
          finalData.role === "CONSULTANT"
            ? {
                create: {
                  description: finalData.description ?? "",
                  qualifications: finalData.qualifications ?? "",
                  specialization: finalData.specialization ?? "",
                  experience: finalData.experience ?? "",
                  domain: { connect: { id: finalData.domain!.id } },
                  subDomains: finalData.subDomains?.length
                    ? {
                        connect: finalData.subDomains.map((sd: SubDomain) => ({
                          id: sd.id,
                        })),
                      }
                    : undefined,
                  tags: finalData.tags?.length
                    ? {
                        connect: finalData.tags.map((t: Tag) => ({ id: t.id })),
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

      console.log("Request Body:", JSON.stringify(requestBody, null, 2));
      toast({
        title: "Updating Onboarding Information",
        description: "Please wait...",
        variant: "default",
      });

      const response = await fetch(`/api/form/onboarding/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        let errorMessage = "Failed to update onboarding information";
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (parseError) {
          console.error("Error parsing response:", parseError);
          const errorText = await response.text();
          console.error("Server response:", errorText);

          if (response.status === 404) {
            errorMessage = "User not found. Please sign out and sign in again.";
            toast({
              title: "User Not Found",
              description: errorMessage,
              variant: "destructive",
            });
            signOut();
            return;
          }
        }

        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        });
        return;
      }

      const result = await response.json();
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
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <Header />
        <ProgressIndicator currentStep={step} totalSteps={4} />
        <WelcomeMessage />
        {renderFormStep()}
      </div>
    </FormProvider>
  );
};

const Header: React.FC = () => (
  <header className="flex items-center space-x-2 mb-8">
    <LogInIcon className="w-8 h-8 text-primary" />
    <h1 className="text-2xl font-bold">ConsultX</h1>
  </header>
);

const WelcomeMessage: React.FC = () => (
  <div className="text-center mb-8">
    <h2 className="text-2xl font-bold">Welcome! First things first...</h2>
    <p className="text-muted-foreground">You can always change them later.</p>
  </div>
);

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
