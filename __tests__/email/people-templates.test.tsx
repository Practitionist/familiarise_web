/**
 * @jest-environment node
 */

/**
 * #1653 — the six people templates render inside the shared layout with
 * their key interpolations and their CTA href in the HTML. The suspension,
 * ban and SSO notices carry the required-notice footer sentence and no
 * unsubscribe link; the SSO subject switches on severity.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountBannedEmail from "@/emails/account/AccountBannedEmail";
import AccountSuspendedEmail from "@/emails/account/AccountSuspendedEmail";
import OrgSsoCertExpiringEmail, {
  orgSsoCertExpiringSubject,
} from "@/emails/organizations/OrgSsoCertExpiringEmail";
import NewReviewEmail from "@/emails/reviews/NewReviewEmail";
import SupportTicketResponseEmail from "@/emails/support/SupportTicketResponseEmail";
import SupportTicketUpdateEmail from "@/emails/support/SupportTicketUpdateEmail";

const ticketUrl = "https://app.test/dashboard";
const unsubscribeUrl = "https://app.test/api/notifications/unsubscribe?t=x";
const REQUIRED = "This is a required account notice and cannot be turned off.";

// `renderEmail()` goes through @react-email/render, whose dynamic import of
// react-dom/server needs --experimental-vm-modules under Jest; the static
// markup is the same tree, which is what these assertions read.
function html(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

it("support reply: names the responder, quotes the reply, previews 140 chars", () => {
  const reply = `${"a".repeat(150)}\nsecond line`;
  const out = html(
    <SupportTicketResponseEmail
      recipientName="Asha"
      reference="ST-2026-0142"
      title="Refund not received"
      respondedBy="Priya"
      replyText={reply}
      ticketUrl={ticketUrl}
      unsubscribeUrl={unsubscribeUrl}
    />,
  );
  expect(out).toContain("Priya replied to your ticket ST-2026-0142");
  expect(out).toContain("Refund not received");
  expect(out).toContain("second line");
  expect(out).toContain(`${"a".repeat(140)}…`);
  expect(out).toContain(`href="${ticketUrl}"`);
  expect(out).toContain(`href="${unsubscribeUrl}"`);
});

it("support update: subject carries the status and the next step is printed", () => {
  const out = html(
    <SupportTicketUpdateEmail
      recipientName="Asha"
      reference="ST-2026-0142"
      title="Refund not received"
      statusLabel="resolved"
      nextStepText="If this fixed the problem, nothing more is needed."
      ticketUrl={ticketUrl}
    />,
  );
  expect(out).toContain("Your ticket ST-2026-0142 is now resolved");
  expect(out).toContain("If this fixed the problem, nothing more is needed.");
  expect(out).toContain(`href="${ticketUrl}"`);
});

it("suspended: required notice with the end date, reason, count and mailto", () => {
  const out = html(
    <AccountSuspendedEmail
      recipientName="Asha"
      reason="Repeated no-shows"
      suspendedUntilText="Tue, 22 Sep 2026 at 4:30 PM IST"
      appointmentsCancelled={2}
      supportEmail="support@familiarisenow.com"
    />,
  );
  expect(out).toContain("Your Familiarise account is suspended");
  expect(out).toContain("Tue, 22 Sep 2026 at 4:30 PM IST");
  expect(out).toContain("Repeated no-shows");
  expect(out).toContain("2 upcoming appointments were cancelled");
  expect(out).toContain('href="mailto:support@familiarisenow.com"');
  expect(out).toContain(REQUIRED);
  expect(out).not.toContain("Unsubscribe");
  expect(out).not.toContain("Manage email preferences");
});

it("banned: required notice, permanent, no cancelled line at zero", () => {
  const out = html(
    <AccountBannedEmail
      recipientName="Asha"
      appointmentsCancelled={0}
      supportEmail="support@familiarisenow.com"
    />,
  );
  expect(out).toContain("Your Familiarise account has been permanently closed");
  expect(out).not.toContain("cancelled as a result");
  expect(out).toContain('href="mailto:support@familiarisenow.com"');
  expect(out).toContain(REQUIRED);
  expect(out).not.toContain("Unsubscribe");
});

it("sso certificate: EXPIRED versus WARN subject, required notice, update CTA", () => {
  const base = {
    orgName: "Acme",
    providerName: "okta-acme",
    expiresAtText: "Tue, 22 Sep 2026 at 4:30 PM IST",
    updateUrl: "https://app.test/dashboard/organization/org_1/settings/sso",
  };
  expect(
    orgSsoCertExpiringSubject({
      orgName: "Acme",
      severity: "WARN",
      daysRemaining: 30,
    }),
  ).toBe("SSO certificate for Acme expires in 30 days");
  expect(
    orgSsoCertExpiringSubject({ orgName: "Acme", severity: "EXPIRED" }),
  ).toBe("SSO certificate for Acme has expired");

  const warn = html(
    <OrgSsoCertExpiringEmail {...base} severity="WARN" daysRemaining={30} />,
  );
  expect(warn).toContain("SSO certificate for Acme expires in 30 days");
  expect(warn).toContain("okta-acme");
  expect(warn).toContain(`href="${base.updateUrl}"`);
  expect(warn).toContain(REQUIRED);
  expect(warn).not.toContain("Unsubscribe");

  const expired = html(
    <OrgSsoCertExpiringEmail {...base} severity="EXPIRED" daysRemaining={-1} />,
  );
  expect(expired).toContain("SSO certificate for Acme has expired");
  expect(expired).toContain("can no longer sign in");
});

it("new review: names the reviewer, the rating, the excerpt and the CTA", () => {
  const out = html(
    <NewReviewEmail
      consultantName="Ravi"
      reviewerName="Asha"
      rating={5}
      excerpt="Clear, patient and well prepared."
      reviewUrl={ticketUrl}
      unsubscribeUrl={unsubscribeUrl}
    />,
  );
  expect(out).toContain("Asha left you a 5-star review");
  expect(out).toContain("5 out of 5");
  expect(out).toContain("Clear, patient and well prepared.");
  expect(out).toContain(`href="${ticketUrl}"`);
  expect(out).toContain(`href="${unsubscribeUrl}"`);
});
