import { getSession } from "@/lib/auth-server";
import { canAddConsultantIdentity } from "@/utils/onboarding-shared";
import { OnboardingWizard } from "./OnboardingWizard";

/**
 * The layout has already run `requireNotOnboarded`; this reads the same
 * (request-cached) session to decide add mode on the server, never from the URL alone.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, params] = await Promise.all([getSession(), searchParams]);
  const addIdentity =
    params.add === "CONSULTANT" &&
    !!session?.user &&
    canAddConsultantIdentity(session.user);
  return (
    <OnboardingWizard
      addIdentity={addIdentity}
      missingProfile={params.error === "missing_profile"}
    />
  );
}
