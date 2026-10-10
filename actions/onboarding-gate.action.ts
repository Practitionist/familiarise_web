"use server";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, onboardingSubmitLimiter } from "@/lib/rate-limit";
import { OnboardingGateSchema } from "@/utils/onboarding";
import {
  canUseOnboardingGate,
  claimOnboardingCompletion,
  recordOnboardingConsent,
} from "@/utils/onboarding-completion";

export type OnboardingGateResult =
  | { success: true }
  | { success: false; error: string; code?: string; field?: string };

/**
 * Complete onboarding for an invitee or org member: an 18+ date of birth and
 * consent, stamped server-side in one transaction with the CAS claim.
 */
export async function completeOnboardingGateAction(
  input: unknown,
): Promise<OnboardingGateResult> {
  const session = await getSession();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };
  const user = session.user;

  const limited = await applyRateLimit(onboardingSubmitLimiter, user.id);
  if (limited) {
    return {
      success: false,
      error: "Too many requests. Please try again later.",
    };
  }

  const parsed = OnboardingGateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      success: false,
      code: "VALIDATION",
      error: issue?.message ?? "Check your answers and try again.",
      ...(typeof field === "string" ? { field } : {}),
    };
  }

  if (user.onboardingCompleted === true) return { success: true };

  const eligible = await canUseOnboardingGate(prisma, {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified === true,
  });
  if (!eligible) {
    return {
      success: false,
      code: "GATE_NOT_ELIGIBLE",
      error: "Finish setting up your account to continue.",
    };
  }

  const gate = parsed.data;
  await prisma.$transaction(async (tx) => {
    const claimed = await claimOnboardingCompletion(tx, user.id, {
      dateOfBirth: gate.dateOfBirth,
    });
    if (claimed) await recordOnboardingConsent(tx, user.id, gate);
  });
  return { success: true };
}
