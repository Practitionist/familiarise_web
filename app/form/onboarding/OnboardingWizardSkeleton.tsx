import { Skeleton } from "@/components/ui/skeleton";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingStepper } from "@/components/onboarding/onboarding-stepper";

/** Onboarding multi-step wizard shell. */
export function OnboardingWizardSkeleton() {
  return (
    <OnboardingShell
      header={
        <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="h-9 w-24" />
        </div>
      }
      stepper={
        <OnboardingStepper
          steps={[
            { key: "personal", label: "Personal Info" },
            { key: "professional", label: "Professional Profile" },
            { key: "availability", label: "Availability" },
            { key: "agreement", label: "Agreement" },
            { key: "review", label: "Review" },
          ]}
          current={0}
        />
      }
      footer={
        <div className="flex items-center justify-center gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-28" />
        </div>
      }
    >
      {/* Matches the real card's width and elevation so the swap from
          skeleton to content does not shift the page. */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-elevation-1 sm:p-8">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="space-y-4 pt-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </OnboardingShell>
  );
}
