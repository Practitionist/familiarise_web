"use server";

import {
  addConsultantIdentity,
  processOnboardingData,
} from "@/utils/onboarding-server";
import { resolveOnboardingEmailUpdate } from "@/utils/onboarding-shared";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { applyRateLimit, onboardingSubmitLimiter } from "@/lib/rate-limit";

// #region Main Server Action
export async function updateOnboardingInformationAction(
  userId: string,
  body: unknown,
): Promise<{
  success: boolean;
  user?: Record<string, unknown>;
  error?: string;
  /** Typed refusal: the server's code and the payload field it is about. */
  code?: string;
  field?: string;
  index?: number;
  verificationWarning?: string;
  verificationDeferred?: boolean;
}> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  // Onboarding is self-only.
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  // The session email is verified at signup; the onboarding body must not
  // move the row onto a different address without re-verification.
  const bodyEmail =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).email
      : undefined;
  const emailCheck = resolveOnboardingEmailUpdate({
    bodyEmail,
    sessionEmail: session.user.email,
  });
  if (!emailCheck.ok) {
    return { success: false, error: emailCheck.error };
  }

  // One submit runs a multi-table CAS transaction + slot fan-out, so cap
  // retry/double-click storms per user. Fail-open on Redis outage matches
  // applyRateLimit's deliberate #1125 semantics.
  const limited = await applyRateLimit(
    onboardingSubmitLimiter,
    session.user.id,
  );
  if (limited) {
    return {
      success: false,
      error: "Too many requests. Please try again later.",
    };
  }

  return processOnboardingData(userId, body);
}
// #endregion

/**
 * Add a consultant identity to an onboarded CONSULTEE / ORG_WORKSPACE account
 * (the wizard's add mode). Same email and rate-limit checks as first-time onboarding.
 */
export async function addConsultantIdentityAction(
  userId: string,
  body: unknown,
): Promise<{
  success: boolean;
  user?: Record<string, unknown>;
  error?: string;
  /** Typed refusal: the server's code and the payload field it is about. */
  code?: string;
  field?: string;
  index?: number;
  verificationWarning?: string;
  verificationDeferred?: boolean;
}> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }
  const bodyEmail =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).email
      : undefined;
  const emailCheck = resolveOnboardingEmailUpdate({
    bodyEmail,
    sessionEmail: session.user.email,
  });
  if (!emailCheck.ok) {
    return { success: false, error: emailCheck.error };
  }
  const limited = await applyRateLimit(
    onboardingSubmitLimiter,
    session.user.id,
  );
  if (limited) {
    return {
      success: false,
      error: "Too many requests. Please try again later.",
    };
  }
  return addConsultantIdentity(userId, body);
}

/**
 * The identity fields the add-mode wizard pre-fills step 0 with. Self only;
 * dates are ISO strings for the wizard's Zod reviver.
 */
export async function loadIdentitySeedAction(): Promise<
  | {
      success: true;
      seed: {
        name: string;
        email: string;
        phone?: string;
        timezone?: string;
        dateOfBirth?: string;
        gender?: string | null;
        city?: string;
        country?: string;
        bio?: string;
        linkedinUrl?: string;
      };
    }
  | { success: false; error: string }
> {
  const session = await getSession();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      phone: true,
      timezone: true,
      dateOfBirth: true,
      gender: true,
      city: true,
      country: true,
      bio: true,
      linkedinUrl: true,
    },
  });
  if (!user) return { success: false, error: "User not found" };
  return {
    success: true,
    seed: {
      name: user.name,
      email: user.email,
      phone: user.phone ?? undefined,
      timezone: user.timezone ?? undefined,
      dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10),
      gender: user.gender,
      city: user.city ?? undefined,
      country: user.country ?? undefined,
      bio: user.bio ?? undefined,
      linkedinUrl: user.linkedinUrl ?? undefined,
    },
  };
}
