/**
 * @jest-environment node
 */

/**
 * #1653 — the six money templates render their amount, their CTA and, for a
 * refund, the policy link; the payout template says "reversed" or "failed"
 * by `kind`. Rendered with react-dom's static markup, which is what
 * `@react-email/render` wraps; its node build needs a dynamic import jest
 * cannot service.
 */

jest.mock("../../lib/url", () => ({ getAppUrl: () => "https://app.test" }));

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RefundProcessedEmail } from "@/emails/payments/RefundProcessedEmail";
import { RefundFailedEmail } from "@/emails/payments/RefundFailedEmail";
import { OrgInvoiceOverdueEmail } from "@/emails/orgs/OrgInvoiceOverdueEmail";
import { OrgWalletLowEmail } from "@/emails/orgs/OrgWalletLowEmail";
import { OrgPayoutFailedEmail } from "@/emails/orgs/OrgPayoutFailedEmail";
import { OrgOverageDueEmail } from "@/emails/orgs/OrgOverageDueEmail";

const unsubscribeUrl = "https://app.test/api/notifications/unsubscribe?u=1";

async function renderEmail(element: React.ReactElement) {
  const html = renderToStaticMarkup(element);
  return { html, text: html };
}

it("refund processed: amount, credit note, receipt CTA and the /refund link", async () => {
  const { html, text } = await renderEmail(
    <RefundProcessedEmail
      recipientName="Asha"
      amountText="₹1,200.00"
      planTitle="Weekly Class"
      creditNoteNumber="CN-2026-0001"
      refundPolicyUrl="https://app.test/refund"
      dashboardUrl="https://app.test/dashboard"
      unsubscribeUrl={unsubscribeUrl}
    />,
  );
  expect(text).toContain("₹1,200.00");
  expect(text).toContain("CN-2026-0001");
  expect(text).toContain("5–7 working days");
  expect(html).toContain('href="https://app.test/dashboard"');
  expect(html).toContain('href="https://app.test/refund"');
  expect(html).toContain(`href="${unsubscribeUrl}"`);
});

it("refund failed: amount and a mailto CTA to the support inbox", async () => {
  const { html, text } = await renderEmail(
    <RefundFailedEmail
      recipientName="Asha"
      amountText="₹1,200.00"
      supportEmail="support@familiarisenow.com"
    />,
  );
  expect(text).toContain("₹1,200.00");
  expect(html).toContain('href="mailto:support@familiarisenow.com"');
});

it("org invoice overdue: invoice, amount, reminder number and the pay CTA", async () => {
  const { html, text } = await renderEmail(
    <OrgInvoiceOverdueEmail
      orgName="Acme"
      invoiceNumber="INV-42"
      amountText="₹50,000.00"
      dueDateText="1 Sep 2026"
      daysLate={14}
      reminderStage={2}
      payUrl="https://app.test/dashboard/organization/org_1/billing"
    />,
  );
  expect(text).toContain("INV-42 is 14 days overdue");
  expect(text).toContain("₹50,000.00");
  expect(text).toContain("reminder 2");
  expect(html).toContain(
    'href="https://app.test/dashboard/organization/org_1/billing"',
  );
});

it("org wallet low: balance, floor and the top-up CTA", async () => {
  const { html, text } = await renderEmail(
    <OrgWalletLowEmail
      orgName="Acme"
      balanceText="₹900.00"
      floorText="₹5,000.00"
      topUpUrl="https://app.test/dashboard/organization/org_1/billing"
    />,
  );
  expect(text).toContain("₹900.00");
  expect(text).toContain("₹5,000.00");
  expect(html).toContain(
    'href="https://app.test/dashboard/organization/org_1/billing"',
  );
});

it("org payout failed: FAILED and REVERSED read differently", async () => {
  const base = {
    orgName: "Acme",
    amountText: "₹10,000.00",
    reason: "Beneficiary account closed",
    dashboardUrl: "https://app.test/dashboard/organization/org_1/payouts",
  };
  const failed = await renderEmail(
    <OrgPayoutFailedEmail kind="FAILED" {...base} />,
  );
  const reversed = await renderEmail(
    <OrgPayoutFailedEmail kind="REVERSED" {...base} />,
  );
  expect(failed.text).toContain("A payout to Acme failed");
  expect(failed.text).toContain("could not be sent");
  expect(reversed.text).toContain("A payout to Acme was reversed");
  expect(reversed.text).toContain("returned by the bank");
  expect(failed.text).toContain("₹10,000.00");
  expect(failed.html).toContain(`href="${base.dashboardUrl}"`);
});

it("org overage due: amount, programme and the pay CTA", async () => {
  const { html, text } = await renderEmail(
    <OrgOverageDueEmail
      recipientName="Ravi"
      orgName="Acme"
      programTitle="Leadership Track"
      amountText="₹800.00"
      dueByText="20 Sep 2026"
      payUrl="https://app.test/dashboard/overage?charge=ov_1"
    />,
  );
  expect(text).toContain("₹800.00");
  expect(text).toContain("Leadership Track");
  expect(text).toContain("Please pay by 20 Sep 2026");
  expect(html).toContain(
    'href="https://app.test/dashboard/overage?charge=ov_1"',
  );
});
