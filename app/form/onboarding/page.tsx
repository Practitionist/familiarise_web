"use client";
import {
  ConsultantProfile,
  ConsulteeProfile,
  PersonalInfoAndRole,
  PreferredSchedule,
  StaffProfile,
  personalInfoAndRoleSchema,
} from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSession } from "next-auth/react";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import ProgressIndicator from "../consultant/plans/components/ui/ProgressIndicator";
import ConsultantPreferredScheduleForm from "./components/ConsultantPreferredScheduleForm";
import ConsultantProfileForm from "./components/ConsultantProfileForm";
import ConsulteeProfileForm from "./components/ConsulteeProfileForm";
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";
import StaffProfileForm from "./components/StaffProfileForm";

type SlotType = {
  startTime: string;
  endTime: string;
};

type WeeklySlotsType = Record<string, SlotType[]>;
type CustomSlotsType = Record<string, SlotType[]>;

type FormData = PersonalInfoAndRole &
  Partial<ConsultantProfile> &
  Partial<ConsulteeProfile> &
  Partial<StaffProfile> &
  Partial<{
    scheduleType: "weekly" | "custom";
    weeklySlots: WeeklySlotsType;
    customSlots: CustomSlotsType;
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
    const updatedData = { ...formData, ...stepData };
    setFormData(updatedData);
    setStep((prevStep) => {
      return prevStep + 1;
    });
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

      const response = await fetch(
        `/api/form/onboarding/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(finalData),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to update onboarding information");
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
                onNext={(data: Partial<ConsultantProfile>) => handleNext(data)}
                onBack={handleBack}
                initialData={{
                  ...formData,
                  scheduleType: formData.scheduleType ?? 'weekly',
                  weeklySlots: formData.weeklySlots ?? {},
                  customSlots: formData.customSlots ?? {},
                }}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteeProfileForm
                onNext={(data: Partial<ConsulteeProfile>) => handleNext(data)}
                onBack={handleBack}
                initialData={formData}
              />
            );
          case "STAFF":
            return (
              <StaffProfileForm
                onSubmit={(data: StaffProfile) => handleSubmit(data)}
                onBack={handleBack}
                initialData={formData}
              />
            );
          default:
            return null;
        }
      case 2:
        if (formData.role === "CONSULTANT") {
          return (
            <ConsultantPreferredScheduleForm
              onSubmit={(data: PreferredSchedule) => handleSubmit(data)}
              onBack={handleBack}
              initialData={formData}
            />
          );
        }
        return null;
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
