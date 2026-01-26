"use server";

import { processOnboardingData } from "@/utils/onboarding-server";

// #region Main Server Action
export async function updateOnboardingInformationAction(
  userId: string,
  body: any,
): Promise<{ success: boolean; user?: any; error?: string }> {
  console.log(
    "Server Action: updateOnboardingInformationAction - Delegating to central utils",
  );

  // Use the central processing function
  return await processOnboardingData(userId, body);
}
// #endregion
