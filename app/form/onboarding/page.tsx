"use client";

import {
  updateOnboardingInformationAction,
  setOnboardingRoleAction,
  completeOrgWorkspaceOnboardingAction,
} from "@/actions/forms/onboarding.action";
import {
  OnboardingFormData,
  OnboardingFormDataSchema,
  transformOnboardingFormToServerData,
} from "@/utils/onboarding";
import { Check, LogOut } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { useToast } from "@/hooks/use-toast";
import { signOut, useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ConsultantPreferredScheduleForm from "./components/ConsultantPreferredScheduleForm";
import ConsultantProfessionalStep from "./components/ConsultantProfessionalStep";
import ConsultantAgreementAndVerificationStep from "./components/ConsultantAgreementAndVerificationStep";
import ConsultantReviewForm from "./components/ConsultantReviewForm";
import ConsulteeAgreementForm from "./components/ConsulteeAgreementForm";
import ConsulteeProfileForm from "./components/ConsulteeProfileForm";
import ConsulteeReviewForm from "./components/ConsulteeReviewForm";
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";
import StaffAgreementForm from "./components/StaffAgreementForm";
import StaffProfileForm from "./components/StaffProfileForm";
import StaffReviewForm from "./components/StaffReviewForm";
import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";

// Step labels for progress indicator
const STEP_LABELS = {
  CONSULTANT: [
    "Personal Info",
    "Professional Profile",
    "Availability",
    "Agreement & Verification",
    "Review",
  ],
  CONSULTEE: ["Personal Info", "Profile", "Agreement", "Review"],
  STAFF: [
    "Personal Info",
    "Role Details",
    "Agreement",
    "Review",
  ],
  // ORG_WORKSPACE: the onboarding shell only owns "Personal Info". Once the
  // role is committed, the shared CreateOrganizationWizard (stepper +
  // cards) takes over the remainder — its own progress bar shows the
  // 5-6 wizard steps, so we don't duplicate them here.
  ORG_WORKSPACE: ["Personal Info"],
};

const MultiStepForm: React.FC = () => {
  const { data: session } = useSession();
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Partial<OnboardingFormData>>({});
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
    } satisfies Partial<OnboardingFormData>,
  });

  const handleNext = async (stepData: Partial<OnboardingFormData>) => {
    // Merge new data first so the async role-flip below reads the
    // freshest values (React setState batching would otherwise give us
    // stale formData).
    const merged: Partial<OnboardingFormData> = { ...formData, ...stepData };
    if (stepData.scheduleType) {
      merged.scheduleType = stepData.scheduleType;
      if (stepData.weeklySlots) {
        merged.weeklySlots = [...stepData.weeklySlots];
      }
      if (stepData.customSlots) {
        merged.customSlots = [...stepData.customSlots];
      }
    }
    setFormData(merged);

    // ORG_WORKSPACE handoff: the onboarding shell only owns step 0. When the
    // user completes Personal Info we commit their role on the User row
    // so step 1's `POST /api/organizations` authorizes — the API gate
    // requires `UserRole === "ORG_WORKSPACE"` and the signup default is
    // CONSULTEE. The shared wizard then takes over for the remaining
    // steps. Any other role keeps using this page's step machine.
    if (step === 0 && merged.role === "ORG_WORKSPACE") {
      const userId = session?.user?.id;
      if (!userId) {
        toast({
          title: "Session Expired",
          description: "Please sign in again to continue.",
          variant: "destructive",
        });
        signOut();
        return;
      }
      // Controlled inputs surface blanks as "" — coerce to undefined so the
      // action's Zod validator (which rejects "" to avoid colliding on the
      // `User.phone @unique` index) sees the field as truly omitted.
      const trimmedPhone = merged.phone?.trim();
      const result = await setOnboardingRoleAction(userId, "ORG_WORKSPACE", {
        name: merged.name?.trim() || undefined,
        phone: trimmedPhone || undefined,
        timezone: merged.timezone?.trim() || undefined,
      });
      if (!result.success) {
        toast({
          title: "Unable to continue",
          description: result.error ?? "Please try again.",
          variant: "destructive",
        });
        return;
      }
    }

    setStep((prevStep) => prevStep + 1);
  };

  const handleBack = () => {
    setStep((prevStep) => prevStep - 1);
  };

  const handleGoToStep = (targetStep: number) => {
    setStep(targetStep);
  };

  const handleSubmit = async (data: Partial<OnboardingFormData>) => {
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
      // Cast needed: OnboardingFormDataSchema is a discriminated union (role-specific output),
      // while OnboardingFormData is an intersection (all fields). The union output satisfies
      // the intersection at runtime (one branch is fully populated) but TS can't prove it.
      const validated = validationResult.data as OnboardingFormData;
      const requestBody = {
        ...transformOnboardingFormToServerData(validated),
        // Include professional background fields (not part of OnboardingData schema)
        workExperiences: validated.workExperiences,
        educationHistory: validated.educationHistory,
        certificationsList: validated.certificationsList,
        achievements: validated.achievements,
      };

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

      if (result.verificationWarning) {
        toast({
          title: "Profile Saved — Verification Issue",
          description: result.verificationWarning as string,
          variant: "destructive",
        });
      } else if (finalData.role === "CONSULTANT") {
        toast({
          title: "Profile Submitted!",
          description:
            "Your verification is under review (1-2 business days). You can start setting up your consultation plans while you wait.",
        });
      } else if (finalData.role === "CONSULTEE") {
        toast({
          title: "Welcome to Familiarise!",
          description:
            "Your profile is ready. Browse our expert directory to book your first session.",
        });
      } else {
        toast({
          title: "Welcome to Familiarise!",
          description: "Your profile has been created successfully.",
        });
      }

      // Check for a pending org invitation token stored by the invite page.
      // This bridges the signup → onboarding → dashboard chain where the
      // callbackUrl would otherwise be lost.
      const pendingToken =
        typeof window !== "undefined"
          ? localStorage.getItem("pendingOrgInviteToken")
          : null;
      if (pendingToken) {
        localStorage.removeItem("pendingOrgInviteToken");
        router.push(`/organizations/invite/${pendingToken}`);
        return;
      }

      // Check for a callbackUrl query param (passed through from signup page)
      const callbackUrl = new URLSearchParams(window.location.search).get(
        "callbackUrl",
      );
      if (callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")) {
        router.push(callbackUrl);
        return;
      }

      // ORG_WORKSPACE flow never reaches this handler — the shared
      // CreateOrganizationWizard's Review step owns the finalize +
      // redirect via `completeOrgWorkspaceOnboardingAction`.

      // Redirect based on role (server has already updated the user record,
      // session cookie will refresh automatically)
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
              <ConsultantProfessionalStep
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData}
                personalInfo={{
                  name: formData.name ?? "",
                  email: formData.email ?? "",
                  phone: formData.phone,
                  address: formData.address,
                  onlineStatus: formData.onlineStatus ?? false,
                  timezone: formData.timezone,
                  onboardingCompleted: formData.onboardingCompleted ?? false,
                  role: formData.role ?? "CONSULTANT",
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
                initialData={formData as Parameters<typeof StaffProfileForm>[0]["initialData"]}
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
              <ConsulteeAgreementForm
                onNext={handleNext}
                onBack={handleBack}
                formData={formData as Parameters<typeof ConsulteeAgreementForm>[0]["formData"]}
              />
            );
          case "STAFF":
            return (
              <StaffAgreementForm
                onNext={handleNext}
                onBack={handleBack}
                initialData={formData as Parameters<typeof StaffAgreementForm>[0]["initialData"]}
              />
            );
          default:
            return null;
        }
      case 3:
        switch (formData.role) {
          case "CONSULTANT":
            return (
              <ConsultantAgreementAndVerificationStep
                onNext={handleNext}
                onBack={handleBack}
                formData={formData}
              />
            );
          case "CONSULTEE":
            return (
              <ConsulteeReviewForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData as Parameters<typeof ConsulteeReviewForm>[0]["formData"]}
                onGoToStep={handleGoToStep}
              />
            );
          case "STAFF":
            return (
              <StaffReviewForm
                onSubmit={handleSubmit}
                onBack={handleBack}
                formData={formData as Parameters<typeof StaffReviewForm>[0]["formData"]}
                onGoToStep={handleGoToStep}
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
                onGoToStep={handleGoToStep}
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
    currentRole in STEP_LABELS
      ? STEP_LABELS[currentRole as keyof typeof STEP_LABELS]
      : STEP_LABELS.CONSULTEE;
  const totalSteps = stepLabels.length;

  // Use wider layout for steps that need more horizontal space
  const wideLayoutSteps = ["Availability"];
  const useWideLayout = wideLayoutSteps.includes(stepLabels[step]);

  // ORG_WORKSPACE handoff: after Personal Info commits the role, render the
  // shared create-org wizard instead of this page's shell. The wizard
  // owns the remaining 5-6 steps (Org Info → Review) and has its own
  // stepper; afterLaunch flips `user.onboardingCompleted = true` so the
  // user lands on their new org's home fully onboarded.
  if (currentRole === "ORG_WORKSPACE" && step > 0) {
    const userId = session?.user?.id;
    return (
      <CreateOrganizationWizard
        onCancel={() => setStep(0)}
        afterLaunch={async () => {
          if (!userId) return;
          await completeOrgWorkspaceOnboardingAction(userId);
        }}
      />
    );
  }

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
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                Step {step + 1} of {totalSteps}
              </span>
              <button
                onClick={() =>
                  signOut({
                    fetchOptions: {
                      onSuccess: () => {
                        window.location.href = "/";
                      },
                    },
                  })
                }
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main
          className={`container mx-auto px-4 py-8 ${useWideLayout ? "max-w-[80%]" : "max-w-3xl"}`}
        >
          {/* Progress Stepper */}
          <div className="flex items-start justify-between mb-8">
            {stepLabels.map((label, index) => (
              <React.Fragment key={label}>
                {/* Step circle + label */}
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-all",
                      index < step &&
                        "bg-primary border-primary text-primary-foreground",
                      index === step &&
                        "bg-primary border-primary text-primary-foreground ring-4 ring-primary/20",
                      index > step &&
                        "border-muted-foreground/30 text-muted-foreground",
                    )}
                  >
                    {index < step ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-xs mt-1.5 text-center max-w-[80px] truncate",
                      index <= step
                        ? "text-primary font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </div>
                {/* Connector line */}
                {index < stepLabels.length - 1 && (
                  <div
                    className={cn(
                      "flex-1 h-0.5 mx-2 mt-[18px] transition-colors",
                      index < step
                        ? "bg-primary"
                        : "bg-muted-foreground/20",
                    )}
                  />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Form Card */}
          <Card className="shadow-lg">
            <CardHeader className="text-center pb-2">
              <CardTitle className="text-2xl">
                {step === 0 ? "Welcome! Let's get started" : stepLabels[step]}
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
