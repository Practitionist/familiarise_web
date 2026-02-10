import { redirect } from "next/navigation";
import { validateReferralCode } from "@/lib/referrals/service";

interface ReferralLandingProps {
  params: Promise<{ code: string }>;
}

export default async function ReferralLandingPage({
  params,
}: ReferralLandingProps) {
  const { code } = await params;

  const referralCode = await validateReferralCode(code);

  if (referralCode) {
    redirect(`/auth/signup?ref=${encodeURIComponent(code)}`);
  }

  // Invalid code - redirect to signup without ref
  redirect("/auth/signup");
}
