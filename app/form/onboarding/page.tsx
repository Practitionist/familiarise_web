"use client";
import { toast } from "@/components/ui/use-toast";
import {
  ConsultantProfile,
  ConsulteePreferences,
  ConsulteeProfile,
  PersonalInfoAndRole,
  PersonalInfoAndRoleSchema,
  PreferredSchedule,
  StaffProfile,
  StaffResponsibilities
} from "@/schemas/UserSchema";
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
import ConsulteePreferencesForm from "./components/ConsulteePreferencesForm";
import ConsulteeProfileForm from "./components/ConsulteeProfileForm";
import ConsulteeReviewForm from "./components/ConsulteeReviewForm";
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";
import StaffAgreementForm from "./components/StaffAgreementForm";
import StaffProfileForm from "./components/StaffProfileForm";
import StaffResponsibilitiesForm from "./components/StaffResponsibilitiesForm";
import StaffReviewForm from "./components/StaffReviewForm";


type FormData = PersonalInfoAndRole &
  Partial<ConsultantProfile> &
  ConsulteeProfile &
  ConsulteePreferences &
  Partial<StaffProfile> &
  Partial<StaffResponsibilities> &
  Partial<PreferredSchedule> &
  Partial<{
    termsAccepted: boolean;
    privacyAccepted: boolean;
  }>;

const MultiStepForm: React.FC = () => {
  const { data: session, update: updateSession } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<FormData>({} as FormData);
  const router = useRouter();

  const methods = useForm<FormData>({
    resolver: zodResolver(PersonalInfoAndRoleSchema),
    defaultValues: {} as FormData,
  });

  const handleNext = (stepData: Partial<FormData>) => {
    setFormData((prevData) => {
      const updatedData = { ...prevData, ...stepData };
      return updatedData;
    });
    setStep((prevStep) => prevStep + 1);
  };

  const handleBack = () => setStep((prevStep) => prevStep - 1);

  const handleSubmit = async (data: Partial<FormData>) => {
    const finalData = { ...formData, ...data };
    console.log("Final Submitted Data:", finalData);
  
    try {
      const id = session?.user?.id;
      if (!id) {
        throw new Error("User ID not found in session");
      }
  
      const response = await fetch(`/api/form/onboarding/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalInfo: {
            name: finalData.name,
            email: finalData.email,
            phone: finalData.phone,
            address: finalData.address,
            currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
          },
          role: finalData.role,
          consultantProfile: finalData.role === "CONSULTANT" ? {
            specialization: finalData.specialization,
            experience: finalData.experience,
            location: finalData.location,
            description: finalData.description,
            tags: finalData.tags,
            domain: finalData.domain,
            subDomains: finalData.subDomains,
            scheduleType: finalData.scheduleType,
            weeklySlots: finalData.weeklySlots,
            customSlots: finalData.customSlots,
          } : undefined,
          consulteeProfile: finalData.role === "CONSULTEE" ? {
            education: finalData.education,
            occupation: finalData.occupation,
            aboutMe: finalData.aboutMe,
            preferredCommunicationMethod: finalData.preferredCommunicationMethod,
            preferredLanguage: finalData.preferredLanguage,
            specialRequirements: finalData.specialRequirements,
            interests: finalData.interests,
          } : undefined,
          staffProfile: finalData.role === "STAFF" ? {
            department: finalData.department,
            position: finalData.position,
            responsibilities: finalData.responsibilities,
          } : undefined,
        }),
      });
  
      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 404) {
          toast({
            title: "User Not Found in Database",
            description: "Please sign out and sign in again.",
            variant: "destructive",
          });
          signOut();
          return
        }
        toast({
          title: "Error",
          description: errorData.message || "Failed to update onboarding information",
          variant: "destructive",
        });
      }
  
      const result = await response.json();
      toast({
        title: "Onboarding Completed",
        description: "Your onboarding information has been updated successfully.",
        variant: "default",
      })
  
      // Update the session
      await updateSession({
        ...session,
        user: {
          ...session?.user,
          onboardingCompleted: true,
          role: finalData.role,
          consultantProfileId: result.consultantProfileId,
          consulteeProfileId: result.consulteeProfileId,
          staffProfileId: result.staffProfileId,
        },
      });
  
      // Redirect based on the user's role
      if (finalData.role === "CONSULTANT" && result.user.consultantProfileId) {
        router.push(`/dashboard/consultant/${result.user.consultantProfileId}`);
      } else if (finalData.role === "CONSULTEE" && result.user.consulteeProfileId) {
        router.push(`/dashboard/consultee/${result.user.consulteeProfileId}`);
      } else if (finalData.role === "STAFF" && result.user.staffProfileId) {
        router.push(`/dashboard/staff/${result.user.staffProfileId}`);
      } else {
        router.push('/dashboard');
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
        title: "Error",
        description: "Something went wrong. Please try again later.",
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
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
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
