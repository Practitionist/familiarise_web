import { Resend } from "resend";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { PaymentSuccessEmail } from "@/emails/payments/PaymentSuccessEmail";
import { PaymentFailedEmail } from "@/emails/payments/PaymentFailedEmail";
import { render } from "@react-email/render";
import { getAppUrl } from "@/lib/url";

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
const baseUrl = getAppUrl();

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

/**
 * Send payment link email when consultant approves request
 * @param params Payment details including amount, consultant name, and payment URL
 * @returns Response from Resend
 */
export async function sendPaymentLinkEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  paymentUrl,
  expiresAt,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  paymentUrl: string;
  expiresAt: Date;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment link email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentLinkEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        paymentUrl,
        expiresAt: expiresAt.toISOString(),
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    console.log(
      `Sending payment link email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Required - ${appointmentLabel} with ${consultantName}`,
      html,
    });

    console.log(
      "Payment link email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment link email:", error);
    return { success: false, error };
  }
}

/**
 * Send payment success confirmation email
 * @param params Payment confirmation details
 * @returns Response from Resend
 */
export async function sendPaymentSuccessEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  receiptUrl,
  dashboardUrl = `${baseUrl}/dashboard`,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  receiptUrl?: string;
  dashboardUrl?: string;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment success email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentSuccessEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        receiptUrl,
        dashboardUrl,
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    console.log(
      `Sending payment success email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Confirmed - ${appointmentLabel} with ${consultantName}`,
      html,
    });

    console.log(
      "Payment success email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment success email:", error);
    return { success: false, error };
  }
}

/**
 * Send payment failure notification email
 * @param params Payment failure details including retry link
 * @returns Response from Resend
 */
export async function sendPaymentFailedEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  retryUrl,
  failureReason = "Payment could not be processed",
  expiresAt,
}: {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: "consultation" | "subscription" | "webinar" | "class";
  amount: number;
  currency: string;
  retryUrl: string;
  failureReason?: string;
  expiresAt?: Date;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send payment failed email.",
      );
      return {
        success: false,
        error: "Email service not configured",
      };
    }

    const html = await render(
      PaymentFailedEmail({
        name,
        consultantName,
        appointmentType,
        amount,
        currency,
        retryUrl,
        failureReason,
        expiresAt: expiresAt?.toISOString(),
      }),
    );

    const appointmentLabel =
      appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1);

    console.log(
      `Sending payment failed email to ${email} for ${appointmentType} with ${consultantName}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise Payments <payments@familiarise.com>",
      to: email,
      subject: `Payment Failed - ${appointmentLabel} with ${consultantName}`,
      html,
    });

    console.log(
      "Payment failed email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send payment failed email:", error);
    return { success: false, error };
  }
}
