"use client";
import {
  ConsultantProfile,
  ConsulteeProfile,
  PersonalInfoAndRole,
  StaffProfile,
  personalInfoAndRoleSchema,
  ConsulteePreferences,
  StaffResponsibilities,
  PreferredSchedule
} from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSession } from "next-auth/react";
import React, { useState } from "react";
import { FormProvider, useForm, UseFormReturn } from "react-hook-form";
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
  Partial<ConsulteeProfile> &
  Partial<StaffProfile> &
  Partial<ConsulteePreferences> &
  Partial<StaffResponsibilities> &
  Partial<PreferredSchedule> &
  Partial<{
    termsAccepted: boolean;
    privacyAccepted: boolean;
  }>;

const MultiStepForm: React.FC = () => {
  const { data: session } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<FormData>({} as FormData);

  const methods = useForm<FormData>({
    resolver: zodResolver(personalInfoAndRoleSchema),
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
        throw new Error("User ID not found");
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
          // Include other role-specific data here
        }),
      });
  
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update onboarding information");
      }
  
      const result = await response.json();
      console.log("Onboarding update successful:", result);
      // Handle successful update (e.g., show success message, redirect)
    } catch (error) {
      console.error("Error updating onboarding information:", error);
      // Handle error (e.g., show error message)
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
