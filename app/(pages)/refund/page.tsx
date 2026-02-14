"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function RefundPolicyPage() {
  return (
    <section className="w-full py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6 lg:px-8">
        {/* Hero Section */}
        <div className="text-center mb-16">
          <div className="flex justify-center mb-6">
            <RefreshCw className="h-20 w-20 text-primary" />
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            {PAGE_META.refund.title}
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-4xl mx-auto leading-relaxed">
            {PAGE_META.refund.description}
          </p>
        </div>

        <div className="max-w-6xl mx-auto">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl md:text-3xl">
                Cancellation &amp; Refund Policy
              </CardTitle>
              <p className="text-base text-muted-foreground">
                Last Updated: {POLICY_DATES.refundLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-lg prose-slate max-w-none dark:prose-invert">
              {/* Section 1: Introduction */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                1. Introduction
              </h2>
              <p className="text-lg leading-relaxed">
                This Cancellation &amp; Refund Policy applies to all services
                offered through the Familiarise platform, including one-on-one
                consultations, classes, webinars, subscription plans, and any
                other paid services available on the platform. Familiarise is
                operated by {COMPANY_INFO.name}.
              </p>
              <p className="text-lg leading-relaxed">
                By purchasing any service on Familiarise, you acknowledge that
                you have read, understood, and agree to the terms outlined in
                this policy. We encourage you to review this policy carefully
                before making any purchase.
              </p>

              <Separator className="my-8" />

              {/* Section 2: Cancellation Policy for Familiarise Services */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                2. Cancellation Policy for Familiarise Services
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.1 One-on-One Consultations
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>24+ hours before session:</strong> Full refund
                </li>
                <li>
                  <strong>12&ndash;24 hours before session:</strong> 50% refund
                </li>
                <li>
                  <strong>Less than 12 hours before session:</strong> No refund
                </li>
                <li>
                  <strong>No-show by Student:</strong> No refund
                </li>
                <li>
                  <strong>No-show by Consultant:</strong> Full refund or free
                  reschedule at your choice
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.2 Classes and Webinars
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>48+ hours before event:</strong> Full refund
                </li>
                <li>
                  <strong>24&ndash;48 hours before event:</strong> 50% refund
                </li>
                <li>
                  <strong>Less than 24 hours before event:</strong> No refund
                </li>
                <li>
                  <strong>Event cancelled by organizer:</strong> Full refund
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.3 Subscription Plans
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  You may cancel your subscription at any time. Your access
                  will continue until the end of the current billing period.
                </li>
                <li>
                  No partial refunds are issued for unused subscription time
                  within a billing cycle.
                </li>
                <li>
                  First-time subscribers may request a full refund within 7
                  days of purchase if the service was unsatisfactory and no
                  significant usage has occurred (7-day satisfaction guarantee).
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 3: Platform Fees and Refund Scope */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                3. Platform Fees and Refund Scope
              </h2>
              <p className="text-lg leading-relaxed">
                It is important to understand the breakdown of fees when you
                make a purchase on Familiarise. Not all components of a
                transaction are eligible for refund:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Platform Service Fee:</strong> The platform service
                  fee charged by Familiarise is non-refundable. This fee covers
                  the cost of maintaining the platform, facilitating bookings,
                  and providing customer support.
                </li>
                <li>
                  <strong>Payment Gateway Fees:</strong> Transaction processing
                  fees charged by our payment partner (Razorpay) are
                  non-refundable. These fees are deducted at the time of
                  payment and cannot be recovered.
                </li>
                <li>
                  <strong>Consultant&apos;s Service Fee:</strong> Only the
                  Consultant&apos;s service portion of the payment is eligible
                  for refund, subject to the cancellation terms outlined in
                  Section 2.
                </li>
              </ul>
              <div className="bg-blue-50 dark:bg-blue-950 p-6 rounded-lg my-6">
                <p className="text-base leading-relaxed">
                  <strong>Example:</strong> If you paid Rs 1,000 for a
                  consultation (Rs 850 Consultant&apos;s service fee + Rs 150
                  platform/gateway fees), a full refund would return Rs 850.
                  The Rs 150 covering platform service fees and payment gateway
                  charges is non-refundable.
                </p>
              </div>
              <p className="text-lg leading-relaxed">
                This applies to all refund scenarios described in this policy,
                including cancellations within the eligible window,
                Consultant-initiated cancellations, and other approved refund
                requests.
              </p>

              <Separator className="my-8" />

              {/* Section 4: General Refund Eligibility */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                4. General Refund Eligibility
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                4.1 Eligible for Refund
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Technical Issues:</strong> The platform was
                  inaccessible or malfunctioned, preventing you from accessing
                  or completing a paid service
                </li>
                <li>
                  <strong>Duplicate Charges:</strong> You were charged multiple
                  times for the same service
                </li>
                <li>
                  <strong>Unauthorized Charges:</strong> Charges were made
                  without your authorization (subject to verification)
                </li>
                <li>
                  <strong>Service Not Delivered:</strong> The Consultant failed
                  to deliver the booked service as described
                </li>
                <li>
                  <strong>Quality Issues:</strong> The service significantly
                  differed from its description on the platform (reviewed on a
                  case-by-case basis)
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                4.2 Not Eligible for Refund
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  Change of mind after the applicable refund window has passed
                </li>
                <li>
                  Failure to cancel a subscription before auto-renewal
                </li>
                <li>
                  Violation of our Terms &amp; Conditions leading to account
                  termination
                </li>
                <li>
                  Services that have already been consumed or completed
                </li>
                <li>
                  Downloaded or accessed digital content (recordings,
                  materials, etc.)
                </li>
                <li>
                  Dissatisfaction with outcomes &mdash; Familiarise does not
                  guarantee specific results from any consultation, class, or
                  other service
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 5: How to Request a Refund */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                5. How to Request a Refund
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                5.1 Refund Request Process
              </h3>
              <p className="text-lg leading-relaxed">
                To request a refund, please email our support team at{" "}
                <a
                  href={getMailtoLink(COMPANY_INFO.supportEmail)}
                  className="text-primary hover:underline"
                >
                  {COMPANY_INFO.supportEmail}
                </a>{" "}
                with the following details:
              </p>
              <ol className="text-lg space-y-2">
                <li>Your registered account email address</li>
                <li>Transaction ID or Order ID</li>
                <li>Platform name (Familiarise)</li>
                <li>Reason for the refund request</li>
                <li>
                  Any supporting documentation (screenshots, error messages,
                  etc.)
                </li>
              </ol>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                5.2 Processing Time
              </h3>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Review Period:</strong> Refund requests are reviewed
                  within 3&ndash;5 business days
                </li>
                <li>
                  <strong>Processing Period:</strong> Approved refunds are
                  processed within 7&ndash;10 business days
                </li>
                <li>
                  <strong>Payment Method:</strong> Refunds are credited to the
                  original payment method used at the time of purchase
                </li>
                <li>
                  <strong>Bank Processing:</strong> Your bank or payment
                  provider may take an additional 5&ndash;7 business days to
                  reflect the credit in your account
                </li>
              </ul>

              <div className="bg-blue-50 dark:bg-blue-950 p-6 rounded-lg my-6">
                <p className="text-base leading-relaxed">
                  <strong>RBI Compliance Note:</strong> For failed transactions
                  where the amount was debited but the service was not
                  activated, refunds are initiated within T+5 business days in
                  compliance with Reserve Bank of India (RBI) guidelines. These
                  refunds are processed automatically through Razorpay and no
                  separate refund request is required. The refund will appear
                  on your statement within 5&ndash;10 business days depending
                  on your bank.
                </p>
              </div>

              <Separator className="my-8" />

              {/* Section 6: Cancellation of Services */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                6. Cancellation of Services
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.1 How to Cancel Subscriptions
              </h3>
              <ol className="text-lg space-y-2">
                <li>Log in to your Familiarise account</li>
                <li>
                  Go to Settings &rarr; Subscriptions
                </li>
                <li>Click &quot;Cancel Subscription&quot;</li>
                <li>
                  Confirm your cancellation. You will receive a confirmation
                  email once the cancellation is processed
                </li>
              </ol>
              <p className="text-lg leading-relaxed">
                Your subscription benefits will remain active until the end of
                the current billing period. Alternatively, you can contact our
                support team at{" "}
                <a
                  href={getMailtoLink(COMPANY_INFO.supportEmail)}
                  className="text-primary hover:underline"
                >
                  {COMPANY_INFO.supportEmail}
                </a>{" "}
                and we will assist you with the cancellation.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.2 How to Cancel Booked Sessions
              </h3>
              <ol className="text-lg space-y-2">
                <li>
                  Go to your Dashboard &rarr; My Bookings
                </li>
                <li>Find the session you wish to cancel</li>
                <li>
                  Click &quot;Cancel Booking&quot; and confirm your
                  cancellation
                </li>
                <li>
                  Your refund will be processed based on the cancellation
                  timelines outlined in Section 2
                </li>
              </ol>

              <Separator className="my-8" />

              {/* Section 7: Consultant-Initiated Cancellations */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                7. Consultant-Initiated Cancellations
              </h2>
              <p className="text-lg leading-relaxed">
                If a Consultant cancels a scheduled session or event:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  You will receive a <strong>full refund</strong> of the
                  service fee (subject to the fee structure described in
                  Section 3) or a <strong>free reschedule</strong> at your
                  choice
                </li>
                <li>
                  Refunds for Consultant-initiated cancellations are
                  automatically processed within 48 hours. No action is
                  required from your end
                </li>
                <li>
                  You will be notified via email about the cancellation and
                  your refund or reschedule options
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 8: Disputed Charges */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                8. Disputed Charges
              </h2>
              <p className="text-lg leading-relaxed">
                If you believe a charge on your account is incorrect or
                unauthorized, please follow these steps:
              </p>
              <ol className="text-lg space-y-2">
                <li>
                  Contact our support team at{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-primary hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>{" "}
                  as soon as possible
                </li>
                <li>
                  Provide the transaction ID, date of charge, and amount in
                  question
                </li>
                <li>
                  Our team will investigate and respond within 3&ndash;5
                  business days
                </li>
              </ol>

              <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-6 rounded-lg my-6">
                <p className="text-base leading-relaxed">
                  <strong>Warning:</strong> Please do not initiate a chargeback
                  or dispute with your bank or payment provider before
                  contacting us directly. Filing a chargeback without first
                  attempting resolution through our support team may result in{" "}
                  <strong>
                    immediate suspension of your Familiarise account
                  </strong>{" "}
                  pending investigation. Chargebacks initiated without prior
                  communication may also delay the resolution process and could
                  affect your ability to use Familiarise services in the
                  future. We are committed to resolving disputes fairly and
                  promptly.
                </p>
              </div>

              <Separator className="my-8" />

              {/* Section 9: Changes to This Policy */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                9. Changes to This Policy
              </h2>
              <p className="text-lg leading-relaxed">
                We may update this Cancellation &amp; Refund Policy from time
                to time. Changes will be posted on this page with an updated
                &quot;Last Updated&quot; date. Existing purchases will be
                honored under the terms that were in effect at the time of
                purchase, unless you explicitly agree to the revised terms.
              </p>

              <Separator className="my-8" />

              {/* Section 10: Contact Us */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                10. Contact Us
              </h2>
              <p className="text-lg leading-relaxed">
                If you have questions about cancellations, refunds, or any
                billing-related matter, please reach out to us:
              </p>
              <div className="bg-muted p-6 rounded-lg mt-6">
                <p className="text-lg">
                  <strong>Company:</strong> {COMPANY_INFO.name}
                </p>
                <p className="text-lg">
                  <strong>Support Email:</strong>{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-primary hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>
                </p>
                <p className="text-lg">
                  <strong>Contact Form:</strong>{" "}
                  <Link
                    href="/contactus"
                    className="text-primary hover:underline"
                  >
                    Submit a Request &rarr;
                  </Link>
                </p>
                <p className="text-lg">
                  <strong>Business Hours:</strong> Monday &ndash; Friday, 10:00
                  AM &ndash; 6:00 PM IST
                </p>
              </div>

              <Separator className="my-8" />

              {/* Need Help? Callout */}
              <div className="bg-yellow-50 dark:bg-yellow-950 p-8 rounded-lg mt-10">
                <h3 className="text-xl font-semibold mb-3">Need Help?</h3>
                <p className="text-base leading-relaxed">
                  If you&apos;re unsure about your refund eligibility or need
                  assistance with a cancellation, our support team is here to
                  help. Reach out to us at{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-primary hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>{" "}
                  or use our{" "}
                  <Link
                    href="/contactus"
                    className="text-primary hover:underline"
                  >
                    contact form
                  </Link>
                  . We&apos;re committed to resolving your concerns as quickly
                  as possible.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
