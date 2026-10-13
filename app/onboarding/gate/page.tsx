import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/auth-guard";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingGateForm } from "@/components/onboarding/OnboardingGateForm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { canUseOnboardingGate } from "@/utils/onboarding-completion";

/**
 * The one onboarding gate for invitees and org members (invite accept, SSO
 * JIT): date of birth and consent, then straight back to `callbackUrl`.
 */
export default async function OnboardingGatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuth();
  const params = await searchParams;
  const rawCallback =
    typeof params.callbackUrl === "string" ? params.callbackUrl : null;
  const callbackUrl = safeSameOriginPath(rawCallback) ?? "/dashboard";

  if (session.user.onboardingCompleted === true) redirect(callbackUrl);

  const eligible = await canUseOnboardingGate(prisma, {
    id: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified === true,
  });
  if (!eligible) {
    redirect(`/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const stored = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { dateOfBirth: true },
  });

  return (
    <OnboardingShell
      header={
        <div className="container mx-auto px-4 py-4">
          <span className="text-xl font-semibold">Familiarise</span>
        </div>
      }
    >
      <Card className="shadow-elevation-2">
        <CardHeader className="pb-2 text-center">
          <CardTitle className="text-fluid-2xl tracking-tight">
            One last step
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Confirm your age and agree to how we handle your data.
          </p>
        </CardHeader>
        <CardContent className="pt-6">
          <OnboardingGateForm
            callbackUrl={callbackUrl}
            defaultDateOfBirth={stored?.dateOfBirth?.toISOString().slice(0, 10)}
          />
        </CardContent>
      </Card>
    </OnboardingShell>
  );
}
