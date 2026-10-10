import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { VerificationEmail } from "@/emails/auth/VerificationEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { ExistingAccountEmail } from "@/emails/auth/ExistingAccountEmail";
import { PasswordChangedEmail } from "@/emails/auth/PasswordChangedEmail";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { PaymentSuccessEmail } from "@/emails/payments/PaymentSuccessEmail";
import { PaymentFailedEmail } from "@/emails/payments/PaymentFailedEmail";
import { OrgInvitationEmail } from "@/emails/organizations/OrgInvitationEmail";
import { WaitlistConfirmEmail } from "@/emails/waitlist/WaitlistConfirmEmail";
import { WaitlistWelcomeEmail } from "@/emails/waitlist/WaitlistWelcomeEmail";
import { buildConfirmUrl, buildUnsubscribeUrl } from "@/lib/waitlist/tokens";
import { getAppUrl } from "@/lib/url";
import { payLinkHref } from "@/lib/payments/pay-link-href";
import { EMAIL_BUDGET_MS, SENDERS, contactInboxAddress } from "./config";
import {
  attempt,
  deliver,
  stage,
  type DeliverOptions,
  type DeliverResult,
  type RenderedEmail,
  type StagedEmail,
  type StageOptions,
} from "./deliver";
import { renderEmail } from "./render";

export { DEFAULT_FROM_ADDRESS, EMAIL_BUDGET_MS, SENDERS } from "./config";
export {
  attempt,
  deliver,
  getResendClient,
  recordFailedEmail,
  stage,
  EmailNotConfiguredError,
  type DeliverOptions,
  type DeliverResult,
  type RenderedEmail,
  type StagedEmail,
  type StageOptions,
} from "./deliver";
export * from "./senders/booking";
export * from "./senders/money";
export * from "./senders/onboarding";
export * from "./senders/people";
export * from "./senders/security";
export * from "./senders/sso";

type AppointmentType = "consultation" | "subscription" | "webinar" | "class";

export type SendOptions = Partial<DeliverOptions>;

export interface StagedSend {
  emailType: string;
  staged: StagedEmail | null;
  message: RenderedEmail;
}

async function renderEnvelope(
  emailType: string,
  element: ReactElement,
  envelope: Omit<RenderedEmail, "html" | "text">,
): Promise<RenderedEmail | { error: unknown }> {
  try {
    const rendered = await renderEmail(element);
    return { ...envelope, ...rendered };
  } catch (error) {
    console.error(`[email] ${emailType} render failed:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType }, level: "warning" },
    );
    return { error };
  }
}

async function send(
  emailType: string,
  element: ReactElement,
  envelope: Omit<RenderedEmail, "html" | "text">,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  const message = await renderEnvelope(emailType, element, envelope);
  if ("error" in message) return { success: false, error: message.error };
  return deliver(message, emailType, opts);
}

async function stageSend(
  emailType: string,
  element: ReactElement,
  envelope: Omit<RenderedEmail, "html" | "text">,
  opts: StageOptions,
): Promise<StagedSend | null> {
  const message = await renderEnvelope(emailType, element, envelope);
  if ("error" in message) return null;
  const staged = await stage(message, emailType, opts);
  return { emailType, staged, message };
}

export async function attemptStagedEmail(
  staged: StagedSend | null,
  budgetMs: number,
): Promise<void> {
  if (!staged) return;
  try {
    await attempt(staged.staged, staged.message, staged.emailType, {
      budgetMs,
    });
  } catch (error) {
    console.error(`[email] ${staged.emailType} attempt failed:`, error);
  }
}

function defineDirectEmailSender<TArgs>(
  build: (args: TArgs) => {
    emailType: string;
    element: ReactElement;
    envelope: Omit<RenderedEmail, "html" | "text">;
    defaults: DeliverOptions;
  },
) {
  return (args: TArgs, opts: SendOptions = {}): Promise<DeliverResult> => {
    const spec = build(args);
    return send(spec.emailType, spec.element, spec.envelope, {
      ...spec.defaults,
      ...opts,
    });
  };
}

const userRef = (userId?: string) => (userId ? `user:${userId}` : undefined);
const paymentRef = (paymentId?: string) =>
  paymentId ? `payment:${paymentId}` : undefined;
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

// ── Auth & Account Senders ──────────────────────────────────────────────────

export const sendWelcomeEmail = defineDirectEmailSender<{
  email: string;
  name: string;
  userId?: string;
  dashboardUrl?: string;
}>(({ email, name, userId, dashboardUrl = `${getAppUrl()}/dashboard` }) => ({
  emailType: "WELCOME",
  element: WelcomeEmail({ name, dashboardUrl }),
  envelope: {
    from: SENDERS.onboarding,
    to: email,
    subject: "Welcome to Familiarise!",
  },
  defaults: { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH },
}));

export const sendPasswordResetEmail = defineDirectEmailSender<{
  email: string;
  name: string;
  token: string;
  userId?: string;
  invite?: boolean;
}>(({ email, name, token, userId, invite = false }) => ({
  emailType: "PASSWORD_RESET",
  element: PasswordResetEmail({
    name,
    // `email` fills the reset page's hidden username field for password managers.
    resetLink: `${getAppUrl()}/auth/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`,
    invite,
  }),
  envelope: {
    from: SENDERS.security,
    to: email,
    subject: invite
      ? "Set your Familiarise staff password"
      : "Reset your Familiarise password",
  },
  defaults: { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH },
}));

export const sendVerificationEmail = defineDirectEmailSender<{
  email: string;
  otp: string;
  expiresInMinutes: number;
}>(({ email, otp, expiresInMinutes }) => {
  if (process.env.NODE_ENV === "development") {
    console.log(`[verify-email] ${email} -> ${otp}`);
  }
  return {
    emailType: "EMAIL_VERIFICATION",
    element: VerificationEmail({ code: otp, expiresInMinutes }),
    envelope: {
      from: SENDERS.onboarding,
      to: email,
      subject: "Your Familiarise verification code",
    },
    defaults: { budgetMs: EMAIL_BUDGET_MS.AUTH },
  };
});

export const sendExistingAccountEmail = defineDirectEmailSender<{
  email: string;
  userId: string;
}>(({ email, userId }) => ({
  emailType: "EXISTING_ACCOUNT_SIGN_UP",
  element: ExistingAccountEmail({
    signInUrl: `${getAppUrl()}/auth/signin`,
    resetUrl: `${getAppUrl()}/auth/forgot-password`,
  }),
  envelope: {
    from: SENDERS.security,
    to: email,
    subject: "Someone tried to sign up with your email",
  },
  defaults: { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH },
}));

export const sendPasswordChangedEmail = defineDirectEmailSender<{
  email: string;
  name: string;
  userId: string;
}>(({ email, name, userId }) => ({
  emailType: "PASSWORD_CHANGED",
  element: PasswordChangedEmail({
    name,
    resetUrl: `${getAppUrl()}/auth/forgot-password`,
  }),
  envelope: {
    from: SENDERS.security,
    to: email,
    subject: "Your Familiarise password was changed",
  },
  defaults: { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH },
}));

export const sendAccountLinkedEmail = defineDirectEmailSender<{
  email: string;
  name: string;
  provider: string;
  userId?: string;
  dashboardUrl?: string;
}>(
  ({
    email,
    name,
    provider,
    userId,
    dashboardUrl = `${getAppUrl()}/dashboard`,
  }) => ({
    emailType: "ACCOUNT_LINKED",
    element: AccountLinkedEmail({ name, provider, dashboardUrl }),
    envelope: {
      from: SENDERS.security,
      to: email,
      subject: `Your Familiarise account is now linked with ${provider}`,
    },
    defaults: { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH },
  }),
);

// ── Payment Senders ─────────────────────────────────────────────────────────

export const PAYMENT_LINK_REMINDER_EMAIL_TYPE = "PAYMENT_LINK_REMINDER";

export function emailPayUrl(
  paymentId: string | undefined,
  paymentUrl: string,
): string {
  const href =
    payLinkHref({ paymentId, checkoutUrl: paymentUrl }) ?? paymentUrl;
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

export const sendPaymentLinkEmail = defineDirectEmailSender<{
  email: string;
  name: string;
  consultantName: string;
  appointmentType: AppointmentType;
  amount: number;
  currency: string;
  paymentUrl: string;
  expiresAt: Date;
  paymentId?: string;
  reminder?: boolean;
}>(
  ({
    email,
    name,
    consultantName,
    appointmentType,
    amount,
    currency,
    paymentUrl,
    expiresAt,
    paymentId,
    reminder = false,
  }) => ({
    emailType: reminder ? PAYMENT_LINK_REMINDER_EMAIL_TYPE : "PAYMENT_LINK",
    element: PaymentLinkEmail({
      name,
      consultantName,
      appointmentType,
      amount,
      currency,
      paymentUrl: emailPayUrl(paymentId, paymentUrl),
      expiresAt: expiresAt.toISOString(),
      reminder,
    }),
    envelope: {
      from: SENDERS.payments,
      to: email,
      subject: reminder
        ? `Reminder: payment due - ${capitalize(appointmentType)} with ${consultantName}`
        : `Payment Required - ${capitalize(appointmentType)} with ${consultantName}`,
    },
    defaults: {
      entityRef: paymentRef(paymentId),
      budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
    },
  }),
);

export interface PaymentSuccessEmailArgs {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: AppointmentType;
  amount: number;
  currency: string;
  receiptUrl?: string;
  dashboardUrl?: string;
  paymentReference?: string;
}

export async function renderPaymentSuccessEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  receiptUrl,
  dashboardUrl = `${getAppUrl()}/dashboard`,
  paymentReference,
}: PaymentSuccessEmailArgs): Promise<RenderedEmail> {
  const rendered = await renderEmail(
    PaymentSuccessEmail({
      name,
      consultantName,
      appointmentType,
      amount,
      currency,
      receiptUrl,
      dashboardUrl,
      paymentReference,
    }),
  );
  return {
    from: SENDERS.payments,
    to: email,
    subject: `Payment Confirmed - ${capitalize(appointmentType)} with ${consultantName}`,
    ...rendered,
  };
}

export interface PaymentFailedEmailArgs {
  email: string;
  name: string;
  consultantName: string;
  appointmentType: AppointmentType;
  amount: number;
  currency: string;
  retryUrl: string;
  failureReason?: string;
  expiresAt?: Date;
  paymentId?: string;
}

export async function renderPaymentFailedEmail({
  email,
  name,
  consultantName,
  appointmentType,
  amount,
  currency,
  retryUrl,
  failureReason = "Payment could not be processed",
  expiresAt,
}: PaymentFailedEmailArgs): Promise<RenderedEmail> {
  const rendered = await renderEmail(
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
  return {
    from: SENDERS.payments,
    to: email,
    subject: `Payment Failed - ${capitalize(appointmentType)} with ${consultantName}`,
    ...rendered,
  };
}

export async function stageOrgInvitationEmail(
  {
    email,
    inviterName,
    orgName,
    role,
    inviteUrl,
    expiresAt,
  }: {
    email: string;
    inviterName: string;
    orgName: string;
    role: string;
    inviteUrl: string;
    expiresAt?: string;
  },
  opts: StageOptions = {},
): Promise<StagedSend | null> {
  return stageSend(
    "ORG_INVITATION",
    OrgInvitationEmail({ inviterName, orgName, role, inviteUrl, expiresAt }),
    {
      from: SENDERS.notifications,
      to: email,
      subject: `You're invited to join ${orgName} on Familiarise`,
    },
    opts,
  );
}

// ── Waitlist & Contact Senders ──────────────────────────────────────────────

export async function sendWaitlistConfirmEmail(
  {
    email,
    name,
    issuedAt,
  }: {
    email: string;
    name?: string | null;
    issuedAt: number;
  },
  opts: SendOptions = {},
) {
  let confirmLink: string;
  try {
    confirmLink = buildConfirmUrl(email, issuedAt);
  } catch (error) {
    console.error("Failed to sign waitlist confirmation link:", error);
    return { success: false as const, error };
  }
  if (process.env.NODE_ENV === "development") {
    console.log(`[waitlist-confirm] ${email} -> ${confirmLink}`);
  }
  return send(
    "WAITLIST_CONFIRM",
    WaitlistConfirmEmail({ name, confirmLink }),
    {
      from: SENDERS.newsletter,
      to: email,
      subject: "Confirm your Familiarise subscription",
    },
    {
      entityRef: `waitlist:${email}`,
      budgetMs: EMAIL_BUDGET_MS.CONTACT_AND_WAITLIST,
      ...opts,
    },
  );
}

export async function sendWaitlistWelcomeEmail(
  { email, name }: { email: string; name?: string | null },
  opts: SendOptions = {},
) {
  let unsubscribeLink: string;
  try {
    unsubscribeLink = buildUnsubscribeUrl(email);
  } catch (error) {
    console.error("Failed to sign waitlist unsubscribe link:", error);
    return { success: false as const, error };
  }
  return send(
    "WAITLIST_WELCOME",
    WaitlistWelcomeEmail({ name, unsubscribeLink }),
    {
      from: SENDERS.newsletter,
      to: email,
      subject: "You are on the Familiarise waitlist",
    },
    {
      entityRef: `waitlist:${email}`,
      budgetMs: EMAIL_BUDGET_MS.CONTACT_AND_WAITLIST,
      ...opts,
    },
  );
}

export async function sendContactInquiryEmail(
  {
    firstName,
    lastName,
    email,
    phone,
    subject,
    message,
    category,
  }: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    subject: string;
    message: string;
    category?: string | null;
  },
  opts: SendOptions = {},
) {
  const name = `${firstName} ${lastName}`.trim();
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const rows: Array<[string, string]> = [
    ["Name", name],
    ["Email", email],
    ["Phone", phone || "—"],
    ["Category", category || "—"],
    ["Subject", subject],
  ];

  const html = `
      <h2>New contact inquiry</h2>
      <table cellpadding="6" style="border-collapse:collapse">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="font-weight:600">${esc(k)}</td><td>${esc(v)}</td></tr>`,
          )
          .join("")}
      </table>
      <h3>Message</h3>
      <p style="white-space:pre-wrap">${esc(message)}</p>
    `;
  const text = [
    "New contact inquiry",
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Message",
    message,
  ].join("\n");

  return deliver(
    {
      from: SENDERS.notifications,
      to: contactInboxAddress(),
      subject: `[Contact] ${subject}`,
      html,
      text,
      replyTo: email,
    },
    "CONTACT_INQUIRY",
    {
      entityRef: `contact:${email}`,
      budgetMs: EMAIL_BUDGET_MS.CONTACT_AND_WAITLIST,
      ...opts,
    },
  );
}
