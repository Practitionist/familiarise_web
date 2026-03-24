/**
 * Waitlist Notifications
 * Email notification helpers for waitlist events
 */

import { Resend } from "resend";
import { render } from "@react-email/render";
import { WaitlistJoinedEmail } from "@/emails/waitlist/WaitlistJoinedEmail";
import { WaitlistSpotAvailableEmail } from "@/emails/waitlist/WaitlistSpotAvailableEmail";
import { WaitlistExpiringEmail } from "@/emails/waitlist/WaitlistExpiringEmail";
import { WaitlistExpiredEmail } from "@/emails/waitlist/WaitlistExpiredEmail";
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
 * Send confirmation email when user joins waitlist
 */
export async function sendWaitlistJoinedEmail(params: {
  email: string;
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  position: number;
  estimatedWait?: string;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send waitlist joined email.",
      );
      return { success: false, error: "Email service not configured" };
    }

    const dashboardUrl = `${baseUrl}/dashboard`;
    const html = await render(
      WaitlistJoinedEmail({
        name: params.name,
        eventTitle: params.eventTitle,
        eventType: params.eventType,
        position: params.position,
        estimatedWait: params.estimatedWait,
        dashboardUrl,
      }),
    );

    console.log(
      `Sending waitlist joined email to ${params.email} for ${params.eventType}: ${params.eventTitle}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise <notifications@familiarise.com>",
      to: params.email,
      subject: `You're on the waitlist for ${params.eventTitle}`,
      html,
    });

    console.log(
      "Waitlist joined email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send waitlist joined email:", error);
    return { success: false, error };
  }
}

/**
 * Send notification when a spot becomes available
 */
export async function sendWaitlistSpotAvailableEmail(params: {
  email: string;
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  eventId: string;
  scheduledDate?: Date;
  expiresAt: Date;
  waitlistId: string;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send spot available email.",
      );
      return { success: false, error: "Email service not configured" };
    }

    // Build the response URL
    const respondUrl = `${baseUrl}/api/waitlist/${params.waitlistId}/respond`;
    const bookNowUrl = `${baseUrl}/checkout/plans/${params.eventType}/${params.eventId}?fromWaitlist=${params.waitlistId}`;

    const html = await render(
      WaitlistSpotAvailableEmail({
        name: params.name,
        eventTitle: params.eventTitle,
        eventType: params.eventType,
        scheduledDate: params.scheduledDate?.toISOString(),
        expiresAt: params.expiresAt.toISOString(),
        bookNowUrl,
        declineUrl: `${respondUrl}?action=DECLINE`,
        skipUrl: `${respondUrl}?action=SKIP`,
      }),
    );

    console.log(
      `Sending spot available email to ${params.email} for ${params.eventType}: ${params.eventTitle}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise <notifications@familiarise.com>",
      to: params.email,
      subject: `A spot is available for ${params.eventTitle}!`,
      html,
    });

    console.log(
      "Spot available email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send spot available email:", error);
    return { success: false, error };
  }
}

/**
 * Send reminder email 12 hours before expiration
 */
export async function sendWaitlistExpiringEmail(params: {
  email: string;
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  eventId: string;
  expiresAt: Date;
  waitlistId: string;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send expiring email.",
      );
      return { success: false, error: "Email service not configured" };
    }

    const bookNowUrl = `${baseUrl}/checkout/plans/${params.eventType}/${params.eventId}?fromWaitlist=${params.waitlistId}`;

    const html = await render(
      WaitlistExpiringEmail({
        name: params.name,
        eventTitle: params.eventTitle,
        eventType: params.eventType,
        expiresAt: params.expiresAt.toISOString(),
        bookNowUrl,
      }),
    );

    console.log(
      `Sending expiring reminder email to ${params.email} for ${params.eventType}: ${params.eventTitle}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise <notifications@familiarise.com>",
      to: params.email,
      subject: `Reminder: Your spot for ${params.eventTitle} expires soon!`,
      html,
    });

    console.log(
      "Expiring reminder email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send expiring email:", error);
    return { success: false, error };
  }
}

/**
 * Send notification when spot offer has expired
 */
export async function sendWaitlistExpiredEmail(params: {
  email: string;
  name: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  rejoinUrl?: string;
}) {
  try {
    const resend = getResendClient();

    if (!resend) {
      console.error(
        "RESEND_API_KEY is not configured. Cannot send expired email.",
      );
      return { success: false, error: "Email service not configured" };
    }

    const dashboardUrl = `${baseUrl}/dashboard`;

    const html = await render(
      WaitlistExpiredEmail({
        name: params.name,
        eventTitle: params.eventTitle,
        eventType: params.eventType,
        rejoinUrl: params.rejoinUrl,
        dashboardUrl,
      }),
    );

    console.log(
      `Sending expired notification email to ${params.email} for ${params.eventType}: ${params.eventTitle}`,
    );

    const data = await resend.emails.send({
      from: "Familiarise <notifications@familiarise.com>",
      to: params.email,
      subject: `Your spot for ${params.eventTitle} has expired`,
      html,
    });

    console.log(
      "Expired notification email sent successfully:",
      data.data?.id ?? "unknown",
    );
    return { success: true, data };
  } catch (error) {
    console.error("Failed to send expired email:", error);
    return { success: false, error };
  }
}
