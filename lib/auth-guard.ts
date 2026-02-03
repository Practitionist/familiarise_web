import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-server";

/**
 * Require an authenticated session. Redirects to sign-in if no session.
 * Returns the validated session (never null).
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }
  return session;
}

/**
 * Require an authenticated AND onboarded user.
 * Redirects to sign-in if no session, or to onboarding if not completed.
 * Uses disableCookieCache to avoid stale onboardingCompleted values.
 */
export async function requireOnboarded() {
  const session = await getSession(true);
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }
  if (!session.user.onboardingCompleted) {
    redirect("/form/onboarding");
  }
  return session;
}

/**
 * Require that onboarding is NOT completed (for the onboarding page).
 * Redirects already-onboarded users to their dashboard.
 * Uses disableCookieCache to avoid stale onboardingCompleted values.
 */
export async function requireNotOnboarded() {
  const session = await getSession(true);
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }
  if (session.user.onboardingCompleted) {
    redirect("/dashboard");
  }
  return session;
}
