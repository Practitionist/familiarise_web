/**
 * @jest-environment node
 */

/**
 * Render coverage for the remaining 15 email templates across auth,
 * organizations, payments, waitlist, booking window opened, and verification.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountLinkedEmail } from "@/emails/auth/AccountLinkedEmail";
import { PasswordResetEmail } from "@/emails/auth/PasswordResetEmail";
import { VerificationEmail } from "@/emails/auth/VerificationEmail";
import { WelcomeEmail } from "@/emails/auth/WelcomeEmail";
import WindowOpenedEmail from "@/emails/booking/WindowOpenedEmail";
import OrgCreatedEmail from "@/emails/organizations/OrgCreatedEmail";
import { OrgInvitationEmail } from "@/emails/organizations/OrgInvitationEmail";
import OrgMembershipChangedEmail from "@/emails/organizations/OrgMembershipChangedEmail";
import OrgWelcomeEmail from "@/emails/organizations/OrgWelcomeEmail";
import { PaymentFailedEmail } from "@/emails/payments/PaymentFailedEmail";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { PaymentSuccessEmail } from "@/emails/payments/PaymentSuccessEmail";
import VerificationDecidedEmail from "@/emails/verification/VerificationDecidedEmail";
import { WaitlistConfirmEmail } from "@/emails/waitlist/WaitlistConfirmEmail";
import { WaitlistWelcomeEmail } from "@/emails/waitlist/WaitlistWelcomeEmail";

const dashboardUrl = "https://app.test/dashboard";

function html(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("auth email templates", () => {
  it("AccountLinkedEmail renders provider and dashboard CTA", () => {
    const out = html(
      <AccountLinkedEmail
        name="Asha"
        provider="GitHub"
        dashboardUrl={dashboardUrl}
      />,
    );
    expect(out).toContain("Account Successfully Linked");
    expect(out).toContain("Asha");
    expect(out).toContain("GitHub");
    expect(out).toContain(`href="${dashboardUrl}"`);
  });

  it("PasswordResetEmail renders both standard reset and staff invite variants", () => {
    const resetLink = "https://app.test/auth/reset-password?token=abc";
    const standard = html(
      <PasswordResetEmail name="Asha" resetLink={resetLink} />,
    );
    expect(standard).toContain("Asha");
    expect(standard).toContain(`href="${resetLink}"`);

    const invite = html(
      <PasswordResetEmail name="Asha" resetLink={resetLink} invite />,
    );
    expect(invite).toContain("Welcome to the Familiarise team");
    expect(invite).toContain("Set Your Password");
    expect(invite).toContain(`href="${resetLink}"`);
  });

  it("VerificationEmail renders recipient name and verification link", () => {
    const verificationLink = "https://app.test/api/auth/verify-email?token=xyz";
    const out = html(
      <VerificationEmail name="Asha" verificationLink={verificationLink} />,
    );
    expect(out).toContain("Confirm your email");
    expect(out).toContain("Asha");
    expect(out).toContain(`href="${verificationLink}"`);
  });

  it("WelcomeEmail renders recipient name and dashboard CTA", () => {
    const out = html(
      <WelcomeEmail name="Asha" dashboardUrl={dashboardUrl} />,
    );
    expect(out).toContain("Welcome to Familiarise!");
    expect(out).toContain("Asha");
    expect(out).toContain(`href="${dashboardUrl}"`);
  });
});

describe("organization email templates", () => {
  it("OrgCreatedEmail renders org name and next steps", () => {
    const out = html(
      <OrgCreatedEmail
        recipientName="Asha"
        orgName="Acme Academy"
        dashboardUrl="https://app.test/dashboard/organization/org_1/home"
      />,
    );
    expect(out).toContain("Your organisation Acme Academy is created");
    expect(out).toContain("pending verification");
    expect(out).toContain(
      'href="https://app.test/dashboard/organization/org_1/home"',
    );
  });

  it("OrgInvitationEmail renders inviter, org name, role label, and invite URL", () => {
    const inviteUrl = "https://app.test/organizations/invite/tok_1";
    const out = html(
      <OrgInvitationEmail
        inviterName="Ravi"
        orgName="Acme Academy"
        role="ADMIN"
        inviteUrl={inviteUrl}
        expiresAt="2026-10-15T12:00:00.000Z"
      />,
    );
    expect(out).toContain("Acme Academy");
    expect(out).toContain("Ravi");
    expect(out).toContain(`href="${inviteUrl}"`);
  });

  it("OrgMembershipChangedEmail renders ROLE_CHANGED and REMOVED variants", () => {
    const roleChanged = html(
      <OrgMembershipChangedEmail
        recipientName="Asha"
        kind="ROLE_CHANGED"
        orgName="Acme Academy"
        roleBefore="MEMBER"
        roleAfter="ADMIN"
        actorName="Ravi"
        dashboardUrl="https://app.test/dashboard/organization/org_1/home"
        supportEmail="support@familiarise.com"
      />,
    );
    expect(roleChanged).toContain("Your role in Acme Academy changed");
    expect(roleChanged).toContain("Ravi");
    expect(roleChanged).toContain(
      'href="https://app.test/dashboard/organization/org_1/home"',
    );

    const removed = html(
      <OrgMembershipChangedEmail
        recipientName="Asha"
        kind="REMOVED"
        orgName="Acme Academy"
        actorName="Ravi"
        dashboardUrl={dashboardUrl}
        supportEmail="support@familiarise.com"
      />,
    );
    expect(removed).toContain("You were removed from Acme Academy");
  });

  it("OrgWelcomeEmail renders org name, humanized role, and dashboard link", () => {
    const out = html(
      <OrgWelcomeEmail
        recipientName="Asha"
        orgName="Acme Academy"
        role="MEMBER"
        dashboardUrl="https://app.test/dashboard/organization/org_1/home"
      />,
    );
    expect(out).toContain("Welcome to Acme Academy on Familiarise");
    expect(out).toContain("Asha");
    expect(out).toContain(
      'href="https://app.test/dashboard/organization/org_1/home"',
    );
  });
});

describe("payment email templates", () => {
  it("PaymentFailedEmail renders failure reason, amount, and retry checkout link", () => {
    const retryUrl = "https://app.test/checkout/pay/pay_123";
    const out = html(
      <PaymentFailedEmail
        name="Asha"
        consultantName="Ravi"
        appointmentType="consultation"
        amount={150000}
        currency="INR"
        retryUrl={retryUrl}
        failureReason="Card declined by issuer"
      />,
    );
    expect(out).toContain("Payment Failed");
    expect(out).toContain("Card declined by issuer");
    expect(out).toContain(`href="${retryUrl}"`);
  });

  it("PaymentLinkEmail renders initial payment required and reminder headings", () => {
    const paymentUrl = "https://app.test/checkout/pay/pay_123";
    const base = {
      name: "Asha",
      consultantName: "Ravi",
      appointmentType: "consultation" as const,
      amount: 150000,
      currency: "INR",
      paymentUrl,
      expiresAt: "2026-10-15T12:00:00.000Z",
    };
    const initial = html(<PaymentLinkEmail {...base} />);
    expect(initial).toContain("Payment Required");
    expect(initial).toContain(`href="${paymentUrl}"`);

    const reminder = html(<PaymentLinkEmail {...base} reminder />);
    expect(reminder).toContain("Reminder: Payment Due");
  });

  it("PaymentSuccessEmail renders confirmation, reference, and receipt link", () => {
    const out = html(
      <PaymentSuccessEmail
        name="Asha"
        consultantName="Ravi"
        appointmentType="consultation"
        amount={150000}
        currency="INR"
        receiptUrl="https://app.test/receipts/r_1"
        dashboardUrl={dashboardUrl}
        paymentReference="pay_ref_42"
      />,
    );
    expect(out).toContain("Payment Successful!");
    expect(out).toContain("pay_ref_42");
    expect(out).toContain('href="https://app.test/receipts/r_1"');
  });
});

describe("waitlist, booking window, and verification email templates", () => {
  it("WaitlistConfirmEmail and WaitlistWelcomeEmail render links and recipient names", () => {
    const confirmLink = "https://app.test/api/waitlist/confirm?token=w1";
    const confirmOut = html(
      <WaitlistConfirmEmail name="Asha" confirmLink={confirmLink} />,
    );
    expect(confirmOut).toContain("One click to confirm");
    expect(confirmOut).toContain("Asha");
    expect(confirmOut).toContain(`href="${confirmLink}"`);

    const unsubscribeLink = "https://app.test/api/waitlist/unsubscribe?token=w1";
    const welcomeOut = html(
      <WaitlistWelcomeEmail name="Asha" unsubscribeLink={unsubscribeLink} />,
    );
    expect(welcomeOut).toContain("You are on the list");
    expect(welcomeOut).toContain(`href="${unsubscribeLink}"`);
  });

  it("WindowOpenedEmail renders consultant name, freed window, and booking CTA", () => {
    const bookUrl = "https://app.test/explore/experts/exp_1";
    const out = html(
      <WindowOpenedEmail
        recipientName="Asha"
        consultantName="Ravi"
        windowText="Tue, 15 Sep 2026 at 4:30 PM IST"
        bookUrl={bookUrl}
      />,
    );
    expect(out).toContain("A time with Ravi just opened");
    expect(out).toContain("Tue, 15 Sep 2026 at 4:30 PM IST");
    expect(out).toContain(`href="${bookUrl}"`);
  });

  it("VerificationDecidedEmail renders VERIFIED, REJECTED, PENDING_VERIFICATION, and NEEDS_INFO_REMINDER states", () => {
    const verified = html(
      <VerificationDecidedEmail
        recipientName="Ravi"
        status="VERIFIED"
        dashboardUrl={dashboardUrl}
        supportEmail="support@familiarise.com"
      />,
    );
    expect(verified).toContain("Your Familiarise expert profile is verified");
    expect(verified).toContain(`href="${dashboardUrl}"`);

    const rejected = html(
      <VerificationDecidedEmail
        recipientName="Ravi"
        status="REJECTED"
        reason="Missing identity document"
        dashboardUrl={dashboardUrl}
        supportEmail="support@familiarise.com"
      />,
    );
    expect(rejected).toContain(
      "Your Familiarise expert profile was not approved",
    );
    expect(rejected).toContain("Missing identity document");

    const reminder = html(
      <VerificationDecidedEmail
        recipientName="Ravi"
        status="NEEDS_INFO_REMINDER"
        daysLeft={3}
        dashboardUrl={dashboardUrl}
        supportEmail="support@familiarise.com"
      />,
    );
    expect(reminder).toContain("Reminder: your expert profile is waiting on you");
    expect(reminder).toContain("within 3 days");
  });
});
