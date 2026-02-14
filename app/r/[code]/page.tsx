import { redirect } from "next/navigation";
import {
  validateReferralCode,
  applyReferralCode,
} from "@/lib/referrals/service";
import { getSession } from "@/lib/auth-server";

interface ReferralLandingProps {
  params: Promise<{ code: string }>;
}

export default async function ReferralLandingPage({
  params,
}: ReferralLandingProps) {
  const { code } = await params;

  const referralCode = await validateReferralCode(code);

  if (!referralCode) {
    // Invalid code - redirect to signup without ref
    redirect("/auth/signup");
  }

  // Check if user is already authenticated
  const session = await getSession();

  if (session?.user?.id) {
    // Authenticated user: apply the referral code directly and redirect to dashboard
    try {
      await applyReferralCode(session.user.id, code);
    } catch (error) {
      // If code application fails (already referred, self-referral, etc.), just continue
      console.error("Failed to apply referral code for logged-in user:", error);
    }
    redirect("/dashboard?ref_applied=true");
  }

  // Unauthenticated user: redirect to signup with ref param
  redirect(`/auth/signup?ref=${encodeURIComponent(code)}`);
}
