"use client";

import { updateOnboardingInformationAction } from "@/actions/forms/onboarding.action";
import {
  OnboardingFormData,
  OnboardingFormDataSchema,
  transformOnboardingFormToServerData,
} from "@/utils/onboarding";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

// Step labels for progress indicator
const STEP_LABELS = {
  CONSULTANT: [
    "Personal Info",
    "Professional Profile",
    "Availability",
    "Agreement",
    "Review",
  ],
  CONSULTEE: [
    "Personal Info",
    "Profile",
    "Preferences",
    "Agreement",
    "Review",
  ],
  STAFF: [
    "Personal Info",
    "Role Details",
    "Responsibilities",
    "Agreement",
    "Review",
  ],
  ADMIN: ["Personal Info", "Admin Setup", "Review"],
};

const MultiStepForm: React.FC = () => {
  const { data: session, update: updateSession } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<OnboardingFormData>({
    preferredCommunicationMethod: "VIDEO",
  } as OnboardingFormData);
  const router = useRouter();
  const { toast } = useToast();

  const methods = useForm<OnboardingFormData>({
    mode: "onChange",
    defaultValues: {
      name: "",
      email: "",
      onlineStatus: false,
      onboardingCompleted: false,
      role: "CONSULTEE",
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

    try {
      const id = session?.user?.id;
      if (!id) {
        toast({
          title: "Session Expired",
          description: "Please sign in again to continue.",
          variant: "destructive",
        });
        signOut();
        return;
      }

      // Validate the form data
      const validationResult = OnboardingFormDataSchema.safeParse(finalData);
      if (!validationResult.success) {
        const errors = validationResult.error.errors;
        const fieldErrors = errors.map((e) => e.path.join(" > ")).join(", ");

        toast({
          title: "Please Complete Required Fields",
          description: `Missing or invalid: ${fieldErrors}`,
          variant: "destructive",
        });

        console.warn("Form validation errors:", errors);
        return;
      }

      // Transform the data for server submission
      const requestBody = transformOnboardingFormToServerData(
        validationResult.data
      );

      toast({
        title: "Saving Your Profile",
        description: "Please wait while we set up your account...",
      });

      const result = await updateOnboardingInformationAction(id, requestBody);

      if (!result.success || !result.user) {
        const errorMessage =
          result.error ?? "Failed to save your profile. Please try again.";

        if (errorMessage.includes("User not found")) {
          toast({
            title: "Account Not Found",
            description: "Your session has expired. Please sign in again.",
            variant: "destructive",
          });
          signOut();
          return;
        }

        toast({
          title: "Unable to Save Profile",
          description: errorMessage,
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Welcome to Familiarise!",
        description: "Your profile has been created successfully.",
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

      // Redirect based on role
      if (finalData.role === "CONSULTANT" && result.user.consultantProfileId) {
        router.push(
          `/dashboard/consultant/${result.user.consultantProfileId}`
        );
      } else if (
        finalData.role === "CONSULTEE" &&
        result.user.consulteeProfileId
      ) {
        router.push(`/dashboard/consultee/${result.user.consulteeProfileId}`);
      } else if (finalData.role === "STAFF" && result.user.staffProfileId) {
        router.push(`/dashboard/staff/${result.user.staffProfileId}`);
      } else if (finalData.role === "ADMIN") {
        router.push("/dashboard/admin/home");
      } else {
        router.push("/dashboard");
      }
    } catch (error: unknown) {
      console.error("Error during onboarding:", error);
      toast({
        title: "Something Went Wrong",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
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
                personalInfo={{
                  name: formData.name,
                  email: formData.email,
                  phone: formData.phone,
                  address: formData.address,
                  onlineStatus: formData.onlineStatus,
                  timezone: formData.timezone,
                  onboardingCompleted: formData.onboardingCompleted,
                  role: formData.role,
                  emailVerified: formData.emailVerified,
                  image: formData.image,
                }}
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

  // Get step labels based on role
  const currentRole = formData.role || "CONSULTEE";
  const stepLabels =
    STEP_LABELS[currentRole as keyof typeof STEP_LABELS] ||
    STEP_LABELS.CONSULTEE;
  const totalSteps = stepLabels.length;
  const progressValue = Math.min(
    100,
    Math.max(0, ((step + 1) / totalSteps) * 100)
  );

  return (
    <FormProvider {...methods}>
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-950">
        {/* Header */}
        <header className="border-b bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-primary-foreground"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
              </div>
              <span className="text-xl font-semibold">Familiarise</span>
            </div>
            <div className="text-sm text-muted-foreground">
              Step {step + 1} of {totalSteps}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="container mx-auto px-4 py-8 max-w-3xl">
          {/* Progress Section */}
          <div className="mb-8">
            <div className="flex justify-between mb-2">
              {stepLabels.map((label, index) => (
                <div
                  key={label}
                  className={`text-xs font-medium transition-colors ${
                    index <= step
                      ? "text-primary"
                      : "text-muted-foreground"
                  }`}
                >
                  {index === step ? label : ""}
                </div>
              ))}
            </div>
            <Progress value={progressValue} className="h-2" />
            <div className="flex justify-between mt-2">
              {stepLabels.map((label, index) => (
                <div
                  key={`dot-${label}`}
                  className={`w-3 h-3 rounded-full transition-colors ${
                    index < step
                      ? "bg-primary"
                      : index === step
                        ? "bg-primary ring-4 ring-primary/20"
                        : "bg-muted"
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Form Card */}
          <Card className="shadow-lg">
            <CardHeader className="text-center pb-2">
              <CardTitle className="text-2xl">
                {step === 0
                  ? "Welcome! Let's get started"
                  : stepLabels[step]}
              </CardTitle>
              <p className="text-muted-foreground text-sm mt-1">
                {step === 0
                  ? "Tell us a bit about yourself. You can always update this later."
                  : "Complete the information below to continue."}
              </p>
            </CardHeader>
            <CardContent className="pt-6">{renderFormStep()}</CardContent>
          </Card>

          {/* Help Text */}
          <p className="text-center text-sm text-muted-foreground mt-6">
            Need help?{" "}
            <a href="/support" className="text-primary hover:underline">
              Contact support
            </a>
          </p>
        </main>
      </div>
    </FormProvider>
  );
};

export default MultiStepForm;
