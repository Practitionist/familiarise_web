"use server";

import { processOnboardingData } from "@/utils/onboarding-server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

// Roles a user is allowed to self-select via this action. Privileged
// roles (ADMIN, STAFF) MUST never be reachable from a client-driven
// action — they are assigned by platform operators out-of-band. Today
// only the ORG_ADMIN handoff routes through this action; CONSULTANT /
// CONSULTEE selection happens earlier in the form via the regular
// `processOnboardingData` path which does not let the caller pick the
// role string. Keep this list narrow on purpose — if a new self-
// service role needs to flow through here, add it explicitly.
const SELF_SELECTABLE_ONBOARDING_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ORG_ADMIN,
]);

// #region Main Server Action
export async function updateOnboardingInformationAction(
  userId: string,
  body: unknown,
): Promise<{ success: boolean; user?: Record<string, unknown>; error?: string; verificationWarning?: string }> {
  console.log(
    "Server Action: updateOnboardingInformationAction - Delegating to central utils",
  );

  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  const isPrivileged =
    session.user.role === "ADMIN" || session.user.role === "STAFF";
  if (!isPrivileged && session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  // Use the central processing function
  return await processOnboardingData(userId, body);
}
// #endregion

/**
 * Persist the user's selected UserRole mid-onboarding. Used by the
 * ORG_ADMIN path so step 1's `POST /api/organizations` sees a session
 * with `role = ORG_ADMIN` (the API gate rejects anything else).
 *
 * This is scoped narrowly on purpose: only the authenticated user
 * can flip their own row, the caller's id must match the session,
 * and `onboardingCompleted` is left alone — the final Review step
 * handles that via `processOnboardingData` once the org is ready.
 */
export async function setOnboardingRoleAction(
  userId: string,
  role: UserRole,
  personalInfo: { name?: string; phone?: string; timezone?: string },
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  // Reject any role outside the self-selection allowlist. The Prisma
  // enum type alone is not a security boundary — a malicious caller
  // can pass `"ADMIN"` / `"STAFF"` and TypeScript would happily allow
  // it from a `.tsx` file, so the runtime check is mandatory.
  if (!SELF_SELECTABLE_ONBOARDING_ROLES.has(role)) {
    return { success: false, error: "Forbidden" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      role,
      name: personalInfo.name ?? undefined,
      phone: personalInfo.phone ?? undefined,
      timezone: personalInfo.timezone ?? undefined,
    },
  });

  return { success: true };
}

/**
 * Flip `user.onboardingCompleted = true` after the ORG_ADMIN wizard
 * finishes launching their first org. Role + personal info were already
 * committed by `setOnboardingRoleAction`; the owner Membership was
 * created atomically by `POST /api/organizations`. All that's left is
 * the onboarding flag so the session no longer redirects to /form/onboarding.
 */
export async function completeOrgAdminOnboardingAction(
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  if (session.user.id !== userId) {
    return { success: false, error: "Forbidden" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompleted: true },
  });

  return { success: true };
}
