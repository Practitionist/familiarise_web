"use client";

import { CalendarClock, Clock, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";
import {
  LegalEditorialLayout,
  type LegalHighlight,
  type LegalSection,
} from "../LegalEditorialLayout";

const REFUND_HIGHLIGHTS: readonly LegalHighlight[] = [
  {
    icon: CalendarClock,
    label: "1:1 Consultations",
    title: "100% >24h · 50% 12–24h",
    description:
      "Cancel >24h before for a 100% consultant-fee refund, or 12–24h prior for 50% (platform & gateway fees excluded).",
  },
  {
    icon: ShieldCheck,
    label: "Host Protection",
    title: "Voided sessions protected",
    description:
      "If a host is absent for 15+ minutes (or half of <30m sessions), consultations are refunded automatically and classes/webinars get a 14-day make-up or refund.",
  },
  {
    icon: Clock,
    label: "Refund Processing",
    title: "7–14 Business Days",
    description:
      "2–3 business days review, initiation within 24–48 hours of approval, then 5–7 business days for your bank.",
  },
  {
    icon: RefreshCw,
    label: "Service Fees",
    title: "Consultant fee portion",
    description:
      "Platform service fees and Razorpay gateway charges are non-refundable; refunds return the eligible consultant fee portion.",
  },
];

const REFUND_SECTIONS: readonly LegalSection[] = [
  {
    title: "1. Introduction",
    content: (
      <>
        <p>
          At Familiarise (&ldquo;{COMPANY_INFO.name}&rdquo;), we understand that
          circumstances change and plans may need to be adjusted. This
          Cancellation &amp; Refund Policy outlines the terms and conditions for
          cancellations and refunds for all services offered on our platform.
        </p>
        <p>
          By booking any service on our platform, you agree to this policy.
          Please read it carefully before making a booking or purchase.
        </p>
      </>
    ),
  },
  {
    title: "2. General Cancellation Policy",
    content: (
      <>
        <p>
          Our cancellation and refund policies vary depending on the type of
          service you have booked. We strive to be fair to both students and
          consultants while maintaining the integrity of scheduled services.
        </p>
        <div className="bg-muted border border-border p-4 rounded-lg mt-4">
          <p className="text-sm">
            <strong>Important:</strong> All cancellation requests must be
            submitted through the platform. Cancellations made outside the
            platform or via direct communication with the consultant will not be
            eligible for refunds.
          </p>
        </div>
      </>
    ),
  },
  {
    title: "3. Service-Specific Cancellation Policies",
    content: (
      <>
        <h3 className="text-xl font-semibold mt-4 mb-2">
          3.1 One-on-One Consultations
        </h3>
        <div className="space-y-3">
          <div>
            <p>
              <strong>Cancellation by Student:</strong>
            </p>
            <ul>
              <li>
                <strong>More than 24 hours before:</strong> Full refund (100% of
                booking amount)
              </li>
              <li>
                <strong>12-24 hours before:</strong> Partial refund (50% of
                booking amount)
              </li>
              <li>
                <strong>Less than 12 hours before:</strong> No refund
              </li>
              <li>
                {/* #1569 B2: learner no-show is forfeited (D7); see 3.5
                    for the support link and recording that come with it. */}
                <strong>No-show:</strong> No refund. If you weren&apos;t able to
                join, use the support link on the appointment and our team can
                review it.
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Cancellation by Consultant:</strong>
            </p>
            <ul>
              <li>
                {/* #1569 B2: consultation host no-show — full refund,
                    no free-reschedule promise (D4). */}
                Full refund (100%) regardless of timing, including a host
                no-show
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Rescheduling:</strong>
            </p>
            <ul>
              <li>
                Students can request one free reschedule if done more than 24
                hours in advance
              </li>
              <li>
                Consultants must accommodate reasonable reschedule requests
              </li>
            </ul>
          </div>
        </div>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          3.2 Live Interactive Classes
        </h3>
        <div className="space-y-3">
          <div>
            <p>
              <strong>Before First Session Starts:</strong>
            </p>
            <ul>
              <li>
                <strong>More than 7 days before start date:</strong> Full refund
                (100%)
              </li>
              <li>
                <strong>3-7 days before start date:</strong> Partial refund
                (75%)
              </li>
              <li>
                <strong>Less than 3 days before start date:</strong> Partial
                refund (50%)
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>After Course Has Started:</strong>
            </p>
            <ul>
              <li>
                <strong>
                  Within first week (after attending max 1 session):
                </strong>{" "}
                Pro-rated refund for remaining sessions minus 20% administration
                fee
              </li>
              <li>
                <strong>After first week:</strong> No refund available
              </li>
              <li>
                Missed sessions due to student absence are not refundable
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Course Cancellation by Consultant:</strong>
            </p>
            <ul>
              <li>
                Full refund (100%) if course is canceled before it starts
              </li>
              <li>
                Pro-rated refund for remaining sessions if canceled mid-course
              </li>
            </ul>
          </div>
        </div>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          3.3 Webinars &amp; Workshops
        </h3>
        <div className="space-y-3">
          <div>
            <p>
              <strong>Cancellation by Student:</strong>
            </p>
            <ul>
              <li>
                <strong>More than 48 hours before event:</strong> Full refund
                (100%)
              </li>
              <li>
                <strong>24-48 hours before event:</strong> Partial refund (50%)
              </li>
              <li>
                <strong>Less than 24 hours before event:</strong> No refund
              </li>
              <li>
                {/* #1569 B2: learner no-show is forfeited (D7); see 3.5
                    for the support link and recording that come with it. */}
                <strong>No-show:</strong> No refund. If you weren&apos;t able to
                join, use the support link on the appointment and our team can
                review it.
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Event Cancellation by Organizer:</strong>
            </p>
            <ul>
              <li>Full refund (100%) regardless of timing</li>
              <li>Platform may offer priority booking for future events</li>
            </ul>
          </div>
        </div>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          3.4 Subscription Plans
        </h3>
        <div className="space-y-3">
          <div>
            <p>
              <strong>Cancellation by Student:</strong>
            </p>
            <ul>
              <li>Subscriptions can be canceled at any time</li>
              <li>No refund for the current billing period</li>
              <li>Access continues until the end of the paid period</li>
              <li>
                Pro-rated refunds available only in case of consultant
                cancellation or service failure
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Mid-Subscription Issues:</strong>
            </p>
            <ul>
              <li>
                If consultant discontinues service mid-subscription, pro-rated
                refund for unused portion
              </li>
              <li>
                If platform experiences prolonged downtime, a pro-rated refund
                may be issued
              </li>
            </ul>
          </div>
        </div>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          3.5 Voided Sessions and Missed-Session Remedies
        </h3>
        {/* #1569 B2: the owner-decided void rule (D1) and remedy (D4,
            D6, D7), stated once here instead of the per-shape "flags
            it after ~2 hours, consultations only" language this section
            replaced. Credits are not offered; every remedy below is a
            cash refund. */}
        <div className="space-y-3">
          <div>
            <p>
              <strong>When a session is voided:</strong>
            </p>
            <ul>
              <li>
                A session is voided when the host is absent, with no
                collaborator or co-presenter present in their place, for at
                least 15 minutes of the booked time, or for half of it on
                sessions shorter than 30 minutes. A learner arriving late does
                not void a session.
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Remedy by service type:</strong>
            </p>
            <ul>
              <li>
                {/* #1833 review: tie the "full refund" promise to
                    Section 6's fee deduction so the amount isn't
                    ambiguous (CodeRabbit). */}
                One-on-one consultation: a host no-show or a session cut short
                by the host is cancelled with a full, automatic refund — the
                same non-refundable-fee deduction in Section 6 applies here as
                it does to every refund on this page.
              </li>
              <li>
                Live classes and webinars: a voided session is offered as a free
                make-up within 14 days; if the make-up isn&apos;t taken, that
                session is refunded automatically.
              </li>
              <li>
                Subscription plans: a voided session returns to your plan&apos;s
                allowance so you can use it later. Any voided session still
                unused when your plan or billing cycle ends is refunded
                automatically.
              </li>
            </ul>
          </div>
          <div>
            <p>
              <strong>Learner no-show:</strong>
            </p>
            <ul>
              <li>
                A learner no-show is not refunded. You&apos;ll get a support
                link on the appointment if you couldn&apos;t get in, along with
                a link to the session recording when your plan records sessions
                and a recording exists. Our support team can review and correct
                the outcome if it was recorded incorrectly.
              </li>
            </ul>
          </div>
        </div>
      </>
    ),
  },
  {
    title: "4. Refund Eligibility and Conditions",
    content: (
      <>
        <h3 className="text-xl font-semibold mt-4 mb-2">
          4.1 Eligible for Refund
        </h3>
        <ul>
          <li>
            Cancellations made within the allowed timeframe as per service type
          </li>
          <li>
            Consultant cancels or fails to attend the scheduled session
          </li>
          <li>
            {/* #1569 B2: reference the void rule instead of
                re-stating it (see 3.5). */}
            A session is voided under the rule in 3.5, and the make-up offered
            for it goes unused or is declined
          </li>
          <li>
            Technical issues on our platform prevent service delivery (verified
            by our team)
          </li>
          <li>
            Service quality does not match the description (subject to review)
          </li>
          <li>Duplicate or erroneous charges</li>
        </ul>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          4.2 Not Eligible for Refund
        </h3>
        <ul>
          <li>Late cancellations outside the allowed timeframe</li>
          <li>No-shows or missed sessions by students</li>
          <li>
            Technical issues on the student&apos;s side (internet, device, etc.)
          </li>
          <li>Change of mind after attending sessions</li>
          <li>
            Dissatisfaction with service after consuming majority of purchased
            sessions
          </li>
          <li>Platform commission fees (non-refundable)</li>
          <li>Payment gateway charges (non-refundable)</li>
        </ul>
      </>
    ),
  },
  {
    title: "5. Refund Process",
    content: (
      <>
        <h3 className="text-xl font-semibold mt-4 mb-2">
          5.1 How to Request a Refund
        </h3>
        <ol>
          <li>Log in to your Familiarise account</li>
          <li>
            Navigate to &ldquo;My Bookings&rdquo; or &ldquo;My
            Subscriptions&rdquo;
          </li>
          <li>Select the booking you wish to cancel</li>
          <li>
            Click &ldquo;Request Cancellation&rdquo; or &ldquo;Request
            Refund&rdquo;
          </li>
          <li>Provide a reason for cancellation (optional but helpful)</li>
          <li>Submit your request</li>
        </ol>
        <p className="mt-3">
          Alternatively, you can contact our support team at{" "}
          <a
            href={getMailtoLink()}
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            {COMPANY_INFO.email}
          </a>{" "}
          with:
        </p>
        <ul>
          <li>Your booking ID or subscription ID</li>
          <li>Reason for cancellation/refund request</li>
          <li>Any supporting documentation (if applicable)</li>
        </ul>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          5.2 Refund Processing Time
        </h3>
        <ul>
          <li>
            <strong>Review Period:</strong> Refund requests are reviewed within
            2-3 business days
          </li>
          <li>
            <strong>Approval Notification:</strong> You will receive an email
            confirmation once approved
          </li>
          <li>
            <strong>Refund Initiation:</strong> Refunds are initiated within
            24-48 hours of approval
          </li>
          <li>
            <strong>Bank Processing Time:</strong> 5-7 business days for the
            amount to reflect in your account
          </li>
          <li>
            <strong>Payment Gateway Delays:</strong> Razorpay may take
            additional time based on your bank&apos;s processing schedule
          </li>
        </ul>
        <div className="rounded-xl border border-border bg-muted/60 p-4 mt-4">
          <p className="text-sm">
            <strong>Note:</strong> The total time from refund request to
            receiving funds in your account may take 7-14 business days
            depending on your bank and payment method.
          </p>
        </div>

        <h3 className="text-xl font-semibold mt-4 mb-2">5.3 Refund Method</h3>
        <ul>
          <li>
            Refunds are processed to the original payment method used for the
            transaction
          </li>
          <li>
            If the original payment method is unavailable, refunds may be issued
            as platform credits
          </li>
          <li>UPI payments are refunded to the UPI ID used for payment</li>
          <li>Card payments are refunded to the original card</li>
          <li>
            Net banking and wallet payments are refunded to the source
            account/wallet
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "6. Platform Commission and Fees",
    content: (
      <>
        <ul>
          <li>
            The platform service fee is <strong>non-refundable</strong> in all
            cases
          </li>
          <li>
            Payment gateway charges (Razorpay fees) are{" "}
            <strong>non-refundable</strong>
          </li>
          <li>
            Only the consultant&apos;s service fee portion is eligible for
            refunds
          </li>
          <li>
            The displayed refund amount will be the amount you receive after
            deducting non-refundable fees
          </li>
        </ul>
        <div className="bg-muted p-4 rounded-lg mt-4">
          <p className="text-sm">
            <strong>Example:</strong> If you paid ₹1,000 for a consultation
            (₹850 consultant fee + ₹150 platform/gateway fees), a full refund
            would return ₹850, not ₹1,000.
          </p>
        </div>
      </>
    ),
  },
  {
    title: "7. Partial Refunds",
    content: (
      <>
        <p>
          Partial refunds may be issued in the following circumstances:
        </p>
        <ul>
          <li>
            Pro-rated refunds for multi-session courses canceled mid-way
          </li>
          <li>
            Late cancellations within specific timeframes (as outlined above)
          </li>
          <li>
            Subscription cancellations with remaining unused sessions
          </li>
          <li>
            Service quality issues affecting only part of the booked service
          </li>
        </ul>
        <p>Partial refund amounts are calculated based on:</p>
        <ul>
          <li>Number of sessions attended vs. total sessions purchased</li>
          <li>Cancellation timing relative to the service date</li>
          <li>Administration fees for processing (where applicable)</li>
        </ul>
      </>
    ),
  },
  {
    title: "8. Technical Issues and Service Failures",
    content: (
      <>
        <h3 className="text-xl font-semibold mt-4 mb-2">
          8.1 Platform Technical Issues
        </h3>
        <p>
          If our platform experiences technical difficulties that prevent
          service delivery — regardless of whether the host joined — the session
          is voided, and the same remedy by service type described in 3.5
          applies:
        </p>
        <ul>
          {/* #1833 review: the earlier bullet order read as a blanket
              make-up-first default that ignored the direct consultation
              refund and the subscription plan-allowance remedy —
              CodeRabbit caught the ambiguity. List the three service
              types explicitly instead of implying one default. */}
          <li>
            For a one-on-one consultation that a platform issue cuts short, we
            refund it directly, without a make-up step
          </li>
          <li>
            For a class or webinar, we offer a free make-up session within 14
            days first; if it goes unused or you decline it, we refund that
            session automatically
          </li>
          <li>
            For a subscription, the session returns to your plan&apos;s
            allowance, and is refunded automatically if it&apos;s still unused
            when your plan or billing cycle ends
          </li>
          <li>
            Report the issue as soon as you can so our technical team can verify
            it
          </li>
        </ul>

        <h3 className="text-xl font-semibold mt-4 mb-2">
          8.2 User-Side Technical Issues
        </h3>
        <p>
          If technical issues occur on the user&apos;s side (poor internet,
          device problems, etc.):
        </p>
        <ul>
          <li>No refund is applicable</li>
          <li>
            Consultant may offer a partial make-up session (at their discretion)
          </li>
          <li>
            Users are responsible for ensuring their setup is compatible before
            sessions
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "9. Emergency and Exceptional Circumstances",
    content: (
      <>
        <p>
          We understand that emergencies happen. In cases of genuine emergency
          situations:
        </p>
        <ul>
          <li>Medical emergencies (documentation may be required)</li>
          <li>Family emergencies</li>
          <li>Natural disasters or force majeure events</li>
          <li>
            Government-mandated restrictions affecting service delivery
          </li>
        </ul>
        <p>
          Please contact our support team immediately with relevant
          documentation. We will review such cases individually and may make
          exceptions to the standard policy at our discretion.
        </p>
      </>
    ),
  },
  {
    title: "10. Disputed Charges",
    content: (
      <>
        <p>
          If you believe you have been incorrectly charged or notice
          unauthorized charges:
        </p>
        <ol>
          <li>
            Contact our support team immediately at{" "}
            <a
              href={getMailtoLink()}
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            >
              {COMPANY_INFO.email}
            </a>
          </li>
          <li>Provide details of the disputed charge with transaction ID</li>
          <li>Do not initiate a chargeback before contacting us</li>
          <li>We will investigate and resolve within 7 business days</li>
        </ol>
        <div className="rounded-xl border border-border bg-muted/60 p-4 mt-4">
          <p className="text-sm">
            <strong>Important:</strong> Initiating a chargeback without
            contacting us first may result in immediate suspension of your
            account until the matter is resolved.
          </p>
        </div>
      </>
    ),
  },
  {
    title: "11. Consultant-Initiated Refunds",
    content: (
      <>
        <p>
          Consultants have the discretion to issue refunds or offer alternative
          compensation in the following situations:
        </p>
        <ul>
          <li>If they are unable to fulfill the service as described</li>
          <li>If they need to cancel or reschedule multiple times</li>
          <li>If the student is not satisfied with the session quality</li>
        </ul>
        <p>
          Consultant-initiated refunds follow the same processing timeline and
          methods as standard refunds.
        </p>
      </>
    ),
  },
  {
    title: "12. Refund Tracking",
    content: (
      <>
        <p>You can track the status of your refund request by:</p>
        <ul>
          <li>
            Checking the &ldquo;My Bookings&rdquo; section in your account
            dashboard
          </li>
          <li>Viewing refund status updates via email notifications</li>
          <li>Contacting support for detailed status information</li>
        </ul>
        <p>Refund statuses include:</p>
        <ul>
          <li>
            <strong>Pending Review:</strong> Your request is being evaluated
          </li>
          <li>
            <strong>Approved:</strong> Refund has been approved and will be
            processed
          </li>
          <li>
            <strong>Processing:</strong> Refund is being processed by payment
            gateway
          </li>
          <li>
            <strong>Completed:</strong> Refund has been sent to your account
          </li>
          <li>
            <strong>Rejected:</strong> Request does not meet refund criteria
            (reason provided)
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "13. Appeals and Disputes",
    content: (
      <>
        <p>
          If your refund request is denied and you believe the decision was
          incorrect:
        </p>
        <ol>
          <li>
            You may appeal the decision within 7 days of the denial notification
          </li>
          <li>
            Provide additional information or documentation supporting your case
          </li>
          <li>
            Our review team will re-evaluate and respond within 5 business days
          </li>
          <li>The decision after appeal is final</li>
        </ol>
      </>
    ),
  },
  {
    title: "14. Changes to This Policy",
    content: (
      <>
        <p>
          We may update this Cancellation &amp; Refund Policy from time to time.
          Any changes will be:
        </p>
        <ul>
          <li>
            Posted on this page with an updated &ldquo;Last Updated&rdquo; date
          </li>
          <li>Communicated via email to all active users</li>
          <li>
            Applied to bookings made after the effective date of the change
          </li>
        </ul>
        <p>
          Existing bookings will be governed by the policy in effect at the time
          of booking.
        </p>
      </>
    ),
  },
  {
    title: "15. Contact Us",
    content: (
      <>
        <p>
          If you have questions about our Cancellation &amp; Refund Policy or
          need assistance with a cancellation or refund request, please contact
          us:
        </p>
        <div className="bg-muted p-4 rounded-lg mt-4">
          <p>
            <strong>Company Name:</strong> {COMPANY_INFO.name}
          </p>
          <p>
            <strong>Email:</strong>{" "}
            <a
              href={getMailtoLink()}
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            >
              {COMPANY_INFO.email}
            </a>
          </p>
          <p>
            <strong>Support:</strong>{" "}
            <Link
              href="/contactus"
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
            >
              Contact Form
            </Link>
          </p>
          <p>
            <strong>Response Time:</strong> We aim to respond to all inquiries
            within 24-48 hours
          </p>
        </div>
      </>
    ),
  },
];

export default function RefundPolicyPage() {
  return (
    <LegalEditorialLayout
      activePolicy="refund"
      eyebrow="Billing & Refunds"
      eyebrowIcon={RefreshCw}
      lastUpdated={POLICY_DATES.refundLastUpdated}
      titlePrefix="Cancellation &"
      titleHighlight="Refund Policy"
      description={PAGE_META.refund.description}
      highlights={REFUND_HIGHLIGHTS}
      sections={REFUND_SECTIONS}
      closingNotice={{
        title: "Fair Treatment for All",
        description:
          "Our cancellation and refund policies are designed to be fair to both students and consultants. We encourage clear communication between all parties and are here to help facilitate positive outcomes. If you have any concerns about a booking or service, please reach out to us before requesting a refund so we can explore all available options.",
      }}
    />
  );
}
