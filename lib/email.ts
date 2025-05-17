import { Resend } from "resend";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { render } from "@react-email/render";

// Initialize Resend with API key
const resend = new Resend(process.env.RESEND_API_KEY);

// Base URL for app
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

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
    const html = await render(WelcomeEmail({ name, dashboardUrl }));

    const data = await resend.emails.send({
      from: "ConsultX <onboarding@consultx.com>",
      to: email,
      subject: "Welcome to ConsultX!",
      html,
    });

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
    const resetLink = `${baseUrl}/auth/reset-password?token=${token}`;
    const html = await render(PasswordResetEmail({ name, resetLink }));

    const data = await resend.emails.send({
      from: "ConsultX Security <security@consultx.com>",
      to: email,
      subject: "Reset your ConsultX password",
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
    const html = await render(
      AccountLinkedEmail({ name, provider, dashboardUrl }),
    );

    const data = await resend.emails.send({
      from: "ConsultX Security <security@consultx.com>",
      to: email,
      subject: `Your ConsultX account now linked with ${provider}`,
      html,
    });

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send account linked email:", error);
    return { success: false, error };
  }
}
