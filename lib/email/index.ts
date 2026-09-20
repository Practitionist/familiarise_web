import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { VerificationEmail } from "@/emails/auth/VerificationEmail";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { PaymentSuccessEmail } from "@/emails/payments/PaymentSuccessEmail";
import { PaymentFailedEmail } from "@/emails/payments/PaymentFailedEmail";
import { OrgInvitationEmail } from "@/emails/organizations/OrgInvitationEmail";
import { WaitlistConfirmEmail } from "@/emails/waitlist/WaitlistConfirmEmail";
import { WaitlistWelcomeEmail } from "@/emails/waitlist/WaitlistWelcomeEmail";
import { buildConfirmUrl, buildUnsubscribeUrl } from "@/lib/waitlist/tokens";
import { getAppUrl } from "@/lib/url";
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

type AppointmentType = "consultation" | "subscription" | "webinar" | "class";

/** Per-call overrides a sender accepts on top of its own entity and budget. */
export type SendOptions = Partial<DeliverOptions>;

/**
 * #1298 — every sender is render → build → deliver. A render-stage throw has
 * nothing to replay (no message yet), so it is reported and returned as a
 * failure here; everything after render dead-letters inside deliver().
 */
async function send(
  emailType: string,
  element: ReactElement,
  envelope: Omit<RenderedEmail, "html" | "text">,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  let rendered: { html: string; text: string };
  try {
    rendered = await renderEmail(element);
  } catch (error) {
    console.error(`[email] ${emailType} render failed:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType }, level: "warning" },
    );
    return { success: false, error };
  }
  return deliver({ ...envelope, ...rendered }, emailType, opts);
}

/**
 * The stage half of `send()` for a route that answers before the vendor
 * call: the FailedEmail row is written now (`stage`), the send runs later
 * through `attemptStagedEmail()` inside `after()`. A render failure is
 * reported and yields null — nothing to attempt, nothing lost but the mail.
 */
export interface StagedSend {
  emailType: string;
  staged: StagedEmail | null;
  message: RenderedEmail;
}

async function stageSend(
  emailType: string,
  element: ReactElement,
  envelope: Omit<RenderedEmail, "html" | "text">,
  opts: StageOptions,
): Promise<StagedSend | null> {
  let rendered: { html: string; text: string };
  try {
    rendered = await renderEmail(element);
  } catch (error) {
    console.error(`[email] ${emailType} render failed:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType }, level: "warning" },
    );
    return null;
  }
  const message = { ...envelope, ...rendered };
  const staged = await stage(message, emailType, opts);
  return { emailType, staged, message };
}

/** The `after()` half of `stageSend()`. Never throws. */
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
    // `attempt` arms its AbortSignal before its own try; keep the caller's
    // never-throws contract whatever the budget was.
    console.error(`[email] ${staged.emailType} attempt failed:`, error);
  }
}

// #1654 — the entity anchor a sender stamps on its outbox row.
const userRef = (userId?: string) => (userId ? `user:${userId}` : undefined);
const paymentRef = (paymentId?: string) =>
  paymentId ? `payment:${paymentId}` : undefined;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Welcome email for a newly registered user. */
export async function sendWelcomeEmail(
  {
    email,
    name,
    userId,
    dashboardUrl = `${getAppUrl()}/dashboard`,
  }: {
    email: string;
    name: string;
    userId?: string;
    dashboardUrl?: string;
  },
  opts: SendOptions = {},
) {
  return send(
    "WELCOME",
    WelcomeEmail({ name, dashboardUrl }),
    {
      from: SENDERS.onboarding,
      to: email,
      subject: "Welcome to Familiarise!",
    },
    { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH, ...opts },
  );
}

/** Password reset link. The token is valid for 30 minutes (lib/auth.ts). */
export async function sendPasswordResetEmail(
  {
    email,
    name,
    token,
    userId,
  }: {
    email: string;
    name: string;
    token: string;
    userId?: string;
  },
  opts: SendOptions = {},
) {
  const resetLink = `${getAppUrl()}/auth/reset-password?token=${token}`;
  return send(
    "PASSWORD_RESET",
    PasswordResetEmail({ name, resetLink }),
    {
      from: SENDERS.security,
      to: email,
      subject: "Reset your Familiarise password",
    },
    { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH, ...opts },
  );
}

/**
 * Email-address verification link. `verificationUrl` is the ready-to-use link
 * BetterAuth hands the hook (token + callbackURL included), passed verbatim.
 */
export async function sendVerificationEmail(
  {
    email,
    name,
    verificationUrl,
    userId,
  }: {
    email: string;
    name: string;
    verificationUrl: string;
    userId?: string;
  },
  opts: SendOptions = {},
) {
  // Dev affordance gated on NODE_ENV, not on the key being absent: the link is
  // a bearer token, and a misconfigured production must not print it.
  if (process.env.NODE_ENV === "development") {
    console.log(`[verify-email] ${email} -> ${verificationUrl}`);
  }
  return send(
    "EMAIL_VERIFICATION",
    VerificationEmail({ name, verificationLink: verificationUrl }),
    {
      from: SENDERS.onboarding,
      to: email,
      subject: "Verify your Familiarise email address",
    },
    { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH, ...opts },
  );
}

/** Notice that an OAuth provider was linked to the account. */
export async function sendAccountLinkedEmail(
  {
    email,
    name,
    provider,
    userId,
    dashboardUrl = `${getAppUrl()}/dashboard`,
  }: {
    email: string;
    name: string;
    provider: string;
    userId?: string;
    dashboardUrl?: string;
  },
  opts: SendOptions = {},
) {
  return send(
    "ACCOUNT_LINKED",
    AccountLinkedEmail({ name, provider, dashboardUrl }),
    {
      from: SENDERS.security,
      to: email,
      subject: `Your Familiarise account now linked with ${provider}`,
    },
    { entityRef: userRef(userId), budgetMs: EMAIL_BUDGET_MS.AUTH, ...opts },
  );
}

/** #1703 D2 — the reminder's `FailedEmail.emailType`; the sweep's once-guard reads it. */
export const PAYMENT_LINK_REMINDER_EMAIL_TYPE = "PAYMENT_LINK_REMINDER";

/** Payment link once a consultant approves a request. */
export async function sendPaymentLinkEmail(
  {
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
  }: {
    email: string;
    name: string;
    consultantName: string;
    appointmentType: AppointmentType;
    amount: number;
    currency: string;
    paymentUrl: string;
    expiresAt: Date;
    paymentId?: string;
    /** #1703 D2 — the half-window reminder, a distinct email type for the once-guard. */
    reminder?: boolean;
  },
  opts: SendOptions = {},
) {
  return send(
    reminder ? PAYMENT_LINK_REMINDER_EMAIL_TYPE : "PAYMENT_LINK",
    PaymentLinkEmail({
      name,
      consultantName,
      appointmentType,
      amount,
      currency,
      paymentUrl,
      expiresAt: expiresAt.toISOString(),
      reminder,
    }),
    {
      from: SENDERS.payments,
      to: email,
      subject: reminder
        ? `Reminder: payment due - ${capitalize(appointmentType)} with ${consultantName}`
        : `Payment Required - ${capitalize(appointmentType)} with ${consultantName}`,
    },
    {
      entityRef: paymentRef(paymentId),
      budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
      ...opts,
    },
  );
}

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

/**
 * #1654 — render only, for a caller that stages inside its own transaction
 * and attempts after commit (the payment webhook). Throws on a render failure;
 * the caller reports it and skips the email, as `send()` does.
 */
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
  // #1298 — the reference is part of the rendered body, so two same-amount
  // receipts to one customer within 24 h get distinct idempotency keys.
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

/** Payment confirmation. */
export async function sendPaymentSuccessEmail(
  args: PaymentSuccessEmailArgs,
  opts: SendOptions = {},
) {
  let message: RenderedEmail;
  try {
    message = await renderPaymentSuccessEmail(args);
  } catch (error) {
    console.error("[email] PAYMENT_SUCCESS render failed:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType: "PAYMENT_SUCCESS" } },
    );
    return { success: false as const, error };
  }
  return deliver(message, "PAYMENT_SUCCESS", {
    entityRef: paymentRef(args.paymentReference),
    budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
    ...opts,
  });
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

/** #1654 — render only; see {@link renderPaymentSuccessEmail}. */
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

/** Payment failure with a retry link. */
export async function sendPaymentFailedEmail(
  args: PaymentFailedEmailArgs,
  opts: SendOptions = {},
) {
  let message: RenderedEmail;
  try {
    message = await renderPaymentFailedEmail(args);
  } catch (error) {
    console.error("[email] PAYMENT_FAILED render failed:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType: "PAYMENT_FAILED" } },
    );
    return { success: false as const, error };
  }
  return deliver(message, "PAYMENT_FAILED", {
    entityRef: paymentRef(args.paymentId),
    budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
    ...opts,
  });
}

/** Organization invitation. */
export async function sendOrgInvitationEmail(
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
  opts: SendOptions = {},
) {
  return send(
    "ORG_INVITATION",
    OrgInvitationEmail({ inviterName, orgName, role, inviteUrl, expiresAt }),
    {
      from: SENDERS.notifications,
      to: email,
      subject: `You're invited to join ${orgName} on Familiarise`,
    },
    { budgetMs: EMAIL_BUDGET_MS.AUTH, ...opts },
  );
}

/** Stage-only twin of `sendOrgInvitationEmail()`; attempt after the response. */
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

// ============================================================================
// Newsletter
// ============================================================================

/**
 * Double opt-in confirmation. The link carries its own issue time so it can
 * expire without a token column — see lib/waitlist/tokens.ts.
 */
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
    // Signing throws when WAITLIST_HMAC_SECRET is unset in production, and a
    // sender must never throw into its caller.
    confirmLink = buildConfirmUrl(email, issuedAt);
  } catch (error) {
    console.error("Failed to sign waitlist confirmation link:", error);
    return { success: false as const, error };
  }

  // Dev affordance gated on NODE_ENV, not on the key being absent: the link is
  // a bearer token, and a misconfigured production must not print it.
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

/** Sent once the confirm link is clicked. */
export async function sendWaitlistWelcomeEmail(
  {
    email,
    name,
  }: {
    email: string;
    name?: string | null;
  },
  opts: SendOptions = {},
) {
  let unsubscribeLink: string;
  try {
    // Same never-throw contract as the confirm sender. Unreachable in practice:
    // confirmSubscription verified the confirm token with this secret first.
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

/**
 * #1132 — contact / enterprise-sales inquiry, routed to the ops inbox with the
 * visitor on Reply-To. Inherits the FailedEmail retry path so a Resend outage
 * does not lose the lead.
 */
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
      // Ops replies go straight to the person who wrote in.
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
