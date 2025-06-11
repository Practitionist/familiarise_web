import { Resend } from "resend";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { render } from "@react-email/render";

// Initialize Resend lazily to avoid build-time issues
let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  
  if (!RESEND_API_KEY) {
    console.warn(
      "WARNING: RESEND_API_KEY is not defined. Email functionality will not work.",
    );
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(RESEND_API_KEY);
  }
  
  return resendClient;
}

// Base URL for app
const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * Send welcome email to newly registered user
 * @param params User email, name, and optional custom URL
 * @returns Response from Resend
 */
export async function sendWelcomeEmail({
  email,
  name,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  dashboardUrl?: string;
}) {
  try {
    const resend = getResendClient();
    
    // Check if Resend client is available
    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send welcome email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    // Render email template
    const html = await render(WelcomeEmail({ name, dashboardUrl }));

    // Send email
    console.log(
      `Attempting to send welcome email to ${email} from onboarding@familiarise.com`,
    );
    const data = await resend.emails.send({
      from: "Familiarise <onboarding@familiarise.com>",
      to: email,
      subject: "Welcome to Familiarise!",
      html,
    });

    console.log("Resend API response:", data);
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send welcome email:", error);
    return { success: false, error };
  }
}

/**
 * Send password reset email with reset link
 * @param params User email, name, and reset token
 * @returns Response from Resend
 */
export async function sendPasswordResetEmail({
  email,
  name,
  token,
}: {
  email: string;
  name: string;
  token: string;
}) {
  try {
    const resend = getResendClient();
    
    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send password reset email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const resetLink = `${baseUrl}/auth/reset-password?token=${token}`;
    const html = await render(PasswordResetEmail({ name, resetLink }));

    const data = await resend.emails.send({
      from: "Familiarise Security <security@familiarise.com>",
      to: email,
      subject: "Reset your Familiarise password",
      html,
    });

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send password reset email:", error);
    return { success: false, error };
  }
}

/**
 * Send account linked notification email
 * @param params User email, name, OAuth provider, and optional dashboard URL
 * @returns Response from Resend
 */
export async function sendAccountLinkedEmail({
  email,
  name,
  provider,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  provider: string;
  dashboardUrl?: string;
}) {
  try {
    const resend = getResendClient();
    
    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send account linked email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      AccountLinkedEmail({ name, provider, dashboardUrl }),
    );

    const data = await resend.emails.send({
      from: "Familiarise Security <security@familiarise.com>",
      to: email,
      subject: `Your Familiarise account now linked with ${provider}`,
      html,
    });

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send account linked email:", error);
    return { success: false, error };
  }
}
