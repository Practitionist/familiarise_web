"use server";

import { processOnboardingData } from "@/utils/onboarding-server";
import { getSession } from "@/lib/auth-server";

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
