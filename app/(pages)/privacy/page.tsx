import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Shield } from "lucide-react";
import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";
import {
  PAYER_SIGNAL_RETENTION_YEARS,
  REFERRAL_SIGNAL_RETENTION_DAYS,
} from "@/lib/compliance/signal-retention";
import { RECORDING_RETENTION_SCHEDULE } from "@/lib/stream/recording-retention-schedule";
import { CompanyDetails } from "../CompanyDetails";
import { COMPANY_INFO } from "@/lib/company";
import {
  GRIEVANCE_OFFICER,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export const metadata: Metadata = {
  title: `${PAGE_META.privacy.title} | Familiarise`,
  description: PAGE_META.privacy.description,
};

export default function PrivacyPolicyPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <Shield className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.privacy.title}
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.privacy.description}
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">Privacy Policy</CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.privacyLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. Introduction
              </h2>
              <p>
                Welcome to Familiarise ("{COMPANY_INFO.name}"). We are committed
                to protecting your privacy and ensuring the security of your
                personal information. This Privacy Policy explains how we
                collect, use, disclose, and safeguard your information when you
                use our platform, website, and services.
              </p>
              <p>
                By accessing or using our services, you agree to this Privacy
                Policy. If you do not agree with the terms of this privacy
                policy, please do not access the site or use our services.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. Information We Collect
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                2.1 Personal Information
              </h3>
              <p>
                We collect personal information that you provide to us when you:
              </p>
              <ul>
                <li>
                  Register for an account (name, email address, phone number)
                  and confirm your age (date of birth)
                </li>
                <li>
                  Complete your profile (professional details, expertise,
                  education)
                </li>
                <li>Book consultations, classes, webinars, or subscriptions</li>
                <li>
                  Make payments (payment card information processed through
                  Razorpay)
                </li>
                <li>Contact our customer support</li>
                <li>Participate in surveys, promotions, or feedback forms</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                2.2 Automatically Collected Information
              </h3>
              <p>
                When you access our platform, we automatically collect certain
                information, including:
              </p>
              <ul>
                <li>
                  Device information (IP address, browser type, operating
                  system)
                </li>
                <li>
                  Usage data needed to run the service (the pages you request
                  and the actions you take, such as bookings)
                </li>
                <li>
                  Location information (approximate location based on IP
                  address)
                </li>
                <li>Essential cookies (see Section 6)</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                2.3 Session and Communication Data
              </h3>
              <p>During your use of our services, we may collect:</p>
              <ul>
                <li>Chat messages and communications between users</li>
                <li>
                  Video conference metadata (session duration, participants,
                  join and leave times)
                </li>
                <li>Course materials and content uploads</li>
                <li>Ratings and reviews</li>
                <li>
                  Reports you make, support requests, the messages and files you
                  send us in them, and our decisions
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                3. How We Use Your Information
              </h2>
              <p>
                We use the collected information for the following purposes:
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.1 Service Delivery
              </h3>
              <ul>
                <li>Create and manage your account</li>
                <li>Process bookings and schedule appointments</li>
                <li>
                  Facilitate communication between consultants and students
                </li>
                <li>Provide video conferencing and chat services</li>
                <li>Deliver course materials and educational content</li>
                <li>Send transactional emails and notifications</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.2 Payment Processing
              </h3>
              <ul>
                <li>Process payments securely through Razorpay</li>
                <li>Manage settlements and refunds</li>
                <li>Prevent fraudulent transactions</li>
                <li>Generate invoices and receipts</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.3 Platform Improvement
              </h3>
              <ul>
                <li>Find and fix errors and slow pages (see Sentry in 4.2)</li>
                <li>Improve user experience and features</li>
                <li>Develop new services and functionalities</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.4 Communication
              </h3>
              <ul>
                <li>Send important updates about your bookings</li>
                <li>Respond to your inquiries and support requests</li>
                <li>Send marketing communications (with your consent)</li>
                <li>Notify you about platform changes and new features</li>
              </ul>

              <h3 className="text-xl font-semibold mt-6 mb-2">
                3.5 What We Use Your Data For, and How Long We Keep It
              </h3>
              <p>
                As India&rsquo;s Digital Personal Data Protection Act, 2023 and
                the Digital Personal Data Protection Rules, 2025 require, the
                table below lists the personal data we process, the specific
                reason for each, and how long we keep it:
              </p>
              <div className="overflow-x-auto my-4">
                <table className="min-w-full text-sm border border-border">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-2 text-left border-b border-border">
                        Data Category
                      </th>
                      <th className="p-2 text-left border-b border-border">
                        What we use it for
                      </th>
                      <th className="p-2 text-left border-b border-border">
                        How long we keep it
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Account &amp; Identity</strong> (name, email,
                        phone, timezone, role, professional bio/credentials,
                        date of birth to confirm you are 18 or older)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Your account</strong> — Create and run your
                        account, sign you in, and confirm you are an adult.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Required</strong> — Kept while your account is
                        open; erased when you delete your account.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Bookings &amp; Scheduling</strong> (selected
                        slots, consultation/subscription/class/webinar bookings,
                        request notes)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Booking sessions</strong> — Schedule, manage and
                        deliver 1:1 consultations, subscriptions, webinars and
                        classes.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Required</strong> — Free-text notes are erased
                        when you delete your account; booking records linked to
                        tax invoices are kept as tax law requires.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Live Video &amp; Chat</strong> (user ID, display
                        name, avatar, session room participation)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Video calls and chat</strong> — Live video calls
                        and messaging, run by GetStream.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Required</strong> — Kept while your account is
                        open; access is cut off when you delete your account.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Payments, Payouts &amp; Tax Records</strong>{" "}
                        (Razorpay order/payment IDs, invoices, consultant
                        earnings, payouts, and PAN, TDS and GST records)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Payments and legal tax records</strong> — Take
                        payments, pay out experts, and keep the invoices and tax
                        records the law requires.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Kept by law</strong> — Retained for 7–8 years
                        under the Income-tax Act, 1961 and the CGST Act, 2017,
                        with your identity replaced by a one-way scrambled code
                        after you delete your account.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Security &amp; Error Diagnostics</strong> (a
                        one-way scrambled code in place of your account ID,
                        trace IDs, error stack traces, security audit logs)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Keeping the platform secure</strong> — Find
                        technical faults, failed checkouts and security
                        incidents without exposing your name, email or phone
                        number.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Legal minimum</strong> — 30–90 days in our
                        error-monitoring tool (Sentry). Sign-in and access logs
                        (IP address and browser) are kept for 180 days after the
                        session ends, as India&rsquo;s cyber-security rules
                        require, and background job logs for 180 days.
                        Payment-provider and email delivery logs are kept for 1
                        year. Staff and organisation activity logs are kept for
                        2 years, or 8 years when they concern money.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Marketing communications</strong> (your email
                        address and newsletter subscription)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Marketing emails</strong> — Send the Familiarise
                        newsletter and emails about our products, offers and
                        updates.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Optional</strong> — Until you turn it off in
                        Settings &rarr; Account.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Support Cases &amp; Evidence</strong> (your
                        request, messages with support, uploaded files, the
                        booking chat messages reviewed for the case, decisions,
                        and a log of every staff access)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Support, Safety &amp; Fraud Prevention</strong>{" "}
                        — Resolve problems you or another party report, keep
                        people safe, and stop fraud and off-platform payment
                        (see section 3.6).
                      </td>
                      <td className="p-2 align-top">
                        {/* counsel: confirm 180 days after closure is adequate for limitation periods and consumer-forum claims. */}
                        {/* counsel: sign-off needed on the split: request, messages, files, chat excerpts and staff case notes deleted; decision explanations and refund and payment-hold reasons kept with the payment and refund records. */}
                        <strong>Case-linked</strong> — Your request text,
                        messages, uploaded files, any booking chat excerpts
                        saved to the case and our team&rsquo;s case notes are
                        deleted or anonymised 180 days after the case and any
                        appeal close, unless a legal hold applies or we need
                        them for a legal claim. We keep the decision record
                        (including its explanation), the reasons for any refund
                        or payment hold, and the related payment and refund
                        records as the law requires. Staff access logs follow
                        the security-log period above.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Session recordings</strong> (the audio and video
                        of a recorded session, and its preview clip)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Video calls and chat</strong> — Let participants
                        replay a session they took part in, and settle disputes
                        about it.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Fixed period</strong> — One-on-one sessions and
                        trials: {RECORDING_RETENTION_SCHEDULE.oneToOneDays} days
                        after the session. Subscriptions:{" "}
                        {RECORDING_RETENTION_SCHEDULE.subscriptionDays} days
                        after the subscription ends. Webinars and classes:{" "}
                        {RECORDING_RETENTION_SCHEDULE.groupDays} days after the
                        session or the class&rsquo;s last session. A recording
                        its host has published for sale, or that someone has
                        bought, is kept while it is on sale or the purchase is
                        live. An organisation that sponsors a session can set a
                        shorter period. Your own one-on-one recordings are
                        deleted when you erase your account.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Fraud-prevention signals</strong> (when a
                        referral code is used: a one-way hash of the IP address,
                        and the browser&rsquo;s user-agent string, which is
                        stored as sent, not hashed, for fraud review; and
                        one-way hashes of the UPI address and phone number a
                        payment was made with)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Support, Safety &amp; Fraud Prevention</strong>{" "}
                        — Detect self-referral and repeat abuse of referral
                        rewards, and support chargeback review.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Fixed period</strong> — The IP hash and the
                        user-agent string are deleted{" "}
                        {REFERRAL_SIGNAL_RETENTION_DAYS} days after the referral
                        ends, {REFERRAL_SIGNAL_RETENTION_DAYS} days after it was
                        created if it never completes, or when you erase your
                        account. Payment hashes are cleared{" "}
                        {PAYER_SIGNAL_RETENTION_YEARS} years after the payment,
                        and stay through account erasure until then.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Consent records</strong> (which purposes you
                        agreed to, the notice version, and when)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Proof of consent</strong> — Show what you agreed
                        to and when you withdrew it, as India&rsquo;s data
                        protection law requires us to be able to prove.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Proof record</strong> — Kept for at least 7
                        years after the consent is given or withdrawn.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="text-xl font-semibold mt-6 mb-2">
                3.6 Messages, Calls and Support Cases
              </h3>
              {/* counsel: confirm these purposes are covered by consent at sign-up (STREAM_DATA_PROCESSING notice) or by DPDP s.7 legitimate use, without relying on "legitimate interest". */}
              <p>
                In-app chat and video help you plan and attend sessions. We also
                process your messages and call data for the specific purposes
                below, and for no others. We explain this in plain terms in our
                help article{" "}
                <Link
                  href={MESSAGE_REVIEW_ARTICLE_HREF}
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  How and why we review messages
                </Link>
                .
              </p>
              <ul>
                <li>
                  <strong>Automated checks for fraud and safety:</strong> our
                  systems may scan in-app chat for signs of fraud or scams,
                  requests to pay outside Familiarise, sharing of phone numbers,
                  email addresses, UPI IDs or payment links before a booking,
                  and safety risks. A match may show you a reminder in the chat.
                  Before a booking is confirmed, we may block a message that
                  shares contact details. An automated match never leads to a
                  penalty by itself: a person checks it first.
                </li>
                <li>
                  <strong>Human review when a booking is reported:</strong> a
                  member of the Familiarise support team may read a
                  booking&rsquo;s chat when a message or the booking is
                  reported, or when the booking has an open support case. Access
                  is linked to that case, limited to that booking&rsquo;s chat,
                  and logged. In a group session, it is limited to the messages
                  of the people involved in the report.
                </li>
                <li>
                  <strong>Visible staff intervention:</strong> when evidence in
                  a case is overdue, or after a report of a safety risk, fraud
                  or a scam, a staff member may join the booking chat as
                  &ldquo;Familiarise Support&rdquo;. Everyone in the chat sees a
                  banner and a system message. We never join silently. Support
                  is removed when the case is resolved.
                </li>
                <li>
                  <strong>Recordings:</strong> support staff can see recording
                  details such as date, length and status. Only a Familiarise
                  administrator can play a recording, for a specific case or
                  report, and every playback is logged.
                </li>
                <li>
                  <strong>Organisation admins:</strong> if an organisation
                  sponsors your session, its admins never see your chat
                  messages. They may see a record that our team reviewed a
                  sponsored session.
                </li>
                <li>
                  <strong>Telling you afterwards:</strong> after a decision, we
                  tell the people in the case that our team reviewed messages
                  related to it.{" "}
                  {/* counsel: confirm the scope of the safety/legal exception to post-decision notice. */}
                  We may delay or skip this notice where it would put someone at
                  risk, help a fraud continue, or break the law.
                </li>
                <li>
                  <strong>Legal requests:</strong> we may disclose messages when
                  Indian law requires it, for example under a valid order from a
                  court or a government agency.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                4. Information Sharing and Disclosure
              </h2>
              <p>
                We do not sell your personal information. We may share your
                information in the following circumstances:
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.1 With Other Users
              </h3>
              <ul>
                <li>Your profile information is visible to other users</li>
                <li>Consultants can see student booking information</li>
                <li>Students can see consultant profiles and availability</li>
                <li>Reviews and ratings are publicly visible</li>
              </ul>

              <h3
                id="data-processors"
                className="text-xl font-semibold mt-4 mb-2"
              >
                4.2 With Service Providers (Data Processors)
              </h3>
              <p>
                We share limited data with trusted third-party Data Processors
                under contractual data-processing and confidentiality
                obligations:
              </p>
              <ul>
                <li>
                  <strong>Razorpay and RazorpayX:</strong> Payment processing,
                  refunds and consultant payouts. Razorpay handles your card and
                  UPI details; we do not store them.
                </li>
                <li>
                  <strong>GetStream.io:</strong> Video conferencing and
                  real-time chat communication
                </li>
                <li>
                  <strong>Supabase:</strong> Our database (hosted in Mumbai,
                  India) and file storage for verification documents and preview
                  clips, including backups
                </li>
                <li>
                  <strong>Cloudflare R2:</strong> Storage for full session
                  recordings and for the files experts sell as digital products
                </li>
                <li>
                  <strong>Cloudflare Turnstile:</strong> A bot check on sign-up,
                  password-reset and code-resend forms. It sends Cloudflare
                  information about your browser and connection.
                </li>
                <li>
                  <strong>Netlify:</strong> Hosting and content delivery. Our
                  application runs on Netlify&rsquo;s servers in Singapore and
                  sees the technical details of each request, such as your IP
                  address.
                </li>
                <li>
                  <strong>Upstash:</strong> Request rate limits and short-lived
                  locks that stop abuse and double bookings, keyed by IP address
                  or account identifier and expiring when the limit window ends
                </li>
                <li>
                  <strong>
                    Email &amp; Notification Providers (Resend / Novu):
                  </strong>{" "}
                  Transactional booking notifications, the in-app inbox and
                  consented marketing emails
                </li>
                <li>
                  <strong>Better Stack:</strong> Uptime checks of our site and
                  operational logs of our background jobs. These logs carry
                  identifiers only, never names or email addresses.
                </li>
                <li>
                  <strong>logo.dev:</strong> Company logos shown next to
                  employers and institutions on profiles. It receives only the
                  company&rsquo;s web domain.
                </li>
                <li>
                  <strong>Have I Been Pwned:</strong> When you choose a
                  password, we check it against known breaches by sending only
                  the first five characters of its SHA-1 hash, never the
                  password.
                </li>
                <li>
                  <strong>Google and GitHub:</strong> Only if you choose to sign
                  in with them. They tell us your name, email address and
                  profile photo.
                </li>
                <li>
                  <strong>
                    Sentry (Functional Software, Inc. — United States,{" "}
                    <code>us.sentry.io</code>):
                  </strong>{" "}
                  Application error monitoring, distributed tracing, and
                  reliability diagnostics. To protect your identity, Familiarise
                  does not send Sentry your name, email address, phone number,
                  IP address, cookies, request or response headers, or the text
                  of the pages you view, and Sentry records no session replays.
                  Where an event is linked to an account, it carries only a
                  one-way scrambled code that cannot be reversed to find you,
                  never your identity. Events are retained for 30–90 days to
                  help our support and engineering teams diagnose technical
                  issues you report.
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.3 Legal Requirements
              </h3>
              <p>We may disclose your information if required by law or to:</p>
              <ul>
                <li>Comply with legal obligations or court orders</li>
                <li>Protect our rights, property, or safety</li>
                <li>Prevent fraud or security threats</li>
                <li>Enforce our Terms & Conditions</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.4 Business Transfers
              </h3>
              <p>
                In the event of a merger, acquisition, or sale of assets, your
                information may be transferred to the acquiring entity. We will
                notify you of any such change and any choices you may have.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                5. Data Security
              </h2>
              <p>
                We implement robust security measures to protect your personal
                information:
              </p>
              <ul>
                <li>
                  <strong>Encryption:</strong> All sensitive data is encrypted
                  in transit and at rest
                </li>
                <li>
                  <strong>Secure Payments:</strong> Payment information is
                  processed through PCI-DSS compliant Razorpay
                </li>
                <li>
                  <strong>Access Controls:</strong> Limited access to personal
                  data by authorized personnel only
                </li>
                <li>
                  <strong>Regular Audits:</strong> Security assessments and
                  vulnerability testing
                </li>
                <li>
                  <strong>Secure Infrastructure:</strong> Hosting on secure
                  cloud platforms with backups
                </li>
              </ul>
              <p>
                While we strive to protect your personal information, no method
                of transmission over the internet or electronic storage is 100%
                secure. We cannot guarantee absolute security.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                6. Cookies and Tracking Technologies
              </h2>
              <p>
                Familiarise uses only essential cookies: the cookies that keep
                you signed in, protect your account and forms against forgery,
                and complete checkout. The platform cannot work without them, so
                they do not need your consent and there is no cookie banner.
              </p>
              <p>
                We do not use analytics, advertising or other non-essential
                cookies, and we do not load third-party tracking scripts. If we
                ever add one, we will ask for your consent before it runs and
                update this policy first.
              </p>
              <p>
                To deliver features you use, the platform loads a few essential
                third-party services. None of them sets cookies on our domain,
                and none is used for advertising or tracking:
              </p>
              <ul>
                <li>
                  <strong>Novu:</strong> the in-app notification inbox
                </li>
                <li>
                  <strong>Stream:</strong> video calls and chat
                </li>
                <li>
                  <strong>Razorpay:</strong> checkout
                </li>
                <li>
                  <strong>Cloudflare Turnstile:</strong> the bot check on
                  sign-up, password-reset and code-resend forms
                </li>
                <li>
                  <strong>Sentry:</strong> error monitoring, with its automatic
                  collection of IP addresses, cookies, request headers and user
                  details turned off, and no session replay
                </li>
              </ul>
              <p>
                What each of these services receives is described in{" "}
                <a href="#data-processors" className="underline">
                  Section 4.2
                </a>
                .
              </p>
              <p>
                You can delete or block cookies in your browser settings.
                Blocking essential cookies will sign you out and stop bookings
                and payments from working.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                7. Your Rights and Choices
              </h2>
              <p>
                You have the following rights regarding your personal
                information:
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.1 Access and Correction
              </h3>
              <ul>
                <li>
                  Access your personal information through your account settings
                </li>
                <li>Update or correct inaccurate information</li>
                <li>Request a copy of your data</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.2 Data Deletion
              </h3>
              <ul>
                <li>Request deletion of your account and associated data</li>
                <li>
                  Note: Some information may be retained for legal or legitimate
                  business purposes
                </li>
                <li>
                  Backup copies may persist for a limited time after deletion
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.3 Marketing Communications
              </h3>
              <ul>
                <li>
                  If you have an account, marketing emails and our newsletter
                  follow your Marketing emails consent in{" "}
                  <strong>Settings &rarr; Account</strong> (&ldquo;Data
                  consent&rdquo;). Giving it subscribes your account&apos;s
                  email address to the newsletter; withdrawing it unsubscribes
                  you.
                </li>
                <li>
                  The &ldquo;unsubscribe&rdquo; link in any newsletter stops it
                  at once and also withdraws that consent for the linked
                  account.
                </li>
                <li>
                  Manage service notifications (bookings, payments, support) in
                  your notification settings
                </li>
                <li>
                  Note: You will still receive essential transactional emails
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.4 Data Portability &amp; Summary of Personal Data
              </h3>
              <ul>
                <li>
                  Download a machine-readable JSON summary of your personal
                  data, booking history, payment records, records of your
                  consent choices, and the list of Data Processors with whom
                  your data has been shared directly from{" "}
                  <strong>Settings &rarr; Account</strong> (&ldquo;Download my
                  data&rdquo;)
                </li>
                <li>
                  Transfer your data to another service (where technically
                  feasible)
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.5 Withdrawing Consent, Complaints &amp; the Data Protection
                Board of India
              </h3>
              <ul>
                <li>
                  <strong>Withdraw Optional Consent Anytime:</strong> You can
                  give or withdraw the optional Marketing emails consent with
                  one click in{" "}
                  <strong>Dashboard &rarr; Settings &rarr; Account</strong>{" "}
                  (&ldquo;Data consent&rdquo;) without affecting your core
                  account access.
                </li>
                <li>
                  <strong>
                    Withdraw Required Consent &amp; Erase Account:
                  </strong>{" "}
                  The consents for running your account, booking sessions and
                  video calls and chat are required to operate your account and
                  deliver bookings. Under India&rsquo;s Digital Personal Data
                  Protection Act, 2023, you may withdraw them at any time by
                  selecting{" "}
                  <strong>Withdraw consent &amp; delete account</strong> in{" "}
                  <strong>Settings &rarr; Account</strong>. If you have active
                  upcoming sessions, unsettled payouts or open chargebacks, we
                  will guide you to complete or cancel them first; upon erasure,
                  your personal identifiers are permanently scrubbed while
                  statutory tax and financial records are retained under Indian
                  tax law.
                </li>
                <li>
                  <strong>Grievance Officer &amp; Response Times:</strong> You
                  may send a complaint in{" "}
                  <strong>Settings &rarr; Account</strong>, on our{" "}
                  <a
                    href="/grievance"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    Grievance Redressal
                  </a>{" "}
                  page, or by emailing{" "}
                  <a
                    href={getMailtoLink()}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                  {". "}Grievances receive an immediate reference number, are
                  acknowledged {GRIEVANCE_OFFICER.ackPromise}, and are resolved{" "}
                  {GRIEVANCE_OFFICER.resolutionPromise}.
                </li>
                <li>
                  <strong>Right to Approach the Data Protection Board:</strong>{" "}
                  If your grievance is not resolved within the statutory period
                  or you are dissatisfied with the resolution, you have the
                  right under India&rsquo;s Digital Personal Data Protection
                  Act, 2023 to make a complaint to the{" "}
                  <strong>Data Protection Board of India</strong>.
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.6 Your Rights in a Support Case
              </h3>
              <ul>
                <li>
                  <strong>Access:</strong> you can see your request, your
                  messages with support, the files you uploaded and our decision
                  on your request page. You can ask for a copy through a
                  grievance.
                </li>
                <li>
                  <strong>Correction:</strong> you can add information or
                  correct what you told us while the case is open, and in an
                  appeal.
                </li>
                {/* counsel: confirm early erasure on request may be refused while a case is open, given the other party's interest in the same evidence. */}
                {/* counsel: sign-off needed on the split: request, messages, files, chat excerpts and staff case notes deleted; decision explanations and refund and payment-hold reasons kept with the payment and refund records. */}
                <li>
                  <strong>Erasure:</strong> your request text, messages, files,
                  any chat excerpts saved to a case and our team&rsquo;s case
                  notes are deleted or anonymised 180 days after the case and
                  any appeal close. If you ask us to erase them sooner, we will,
                  unless we need them for an open case, a legal claim or a legal
                  hold. The decision record (including its explanation), the
                  reasons for any refund or payment hold, and payment and refund
                  records are kept as the law requires.
                </li>
                <li>
                  <strong>Appeal and grievance:</strong> you can appeal a
                  support decision once, within 7 days. You can also contact our
                  Grievance Officer as described in section 7.5.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                8. Children's Privacy
              </h2>
              <p>
                Familiarise is for adults. You must be at least 18 years old to
                use it. Under the Digital Personal Data Protection Act, 2023, a
                child is anyone who has not completed eighteen years of age, and
                we do not knowingly collect personal information from anyone
                under 18.
              </p>
              <p>
                During onboarding we ask for your date of birth and for your
                confirmation that you are 18 or older, and we refuse an account
                for a date of birth under 18. We collect the date of birth only
                to confirm that you are not a child, a purpose permitted by Part
                B, item 6 of the Fourth Schedule to the Digital Personal Data
                Protection Rules, 2025.
              </p>
              <p>
                If you are a parent or guardian and believe your child has
                provided us with personal information, please contact us
                immediately and we will take steps to delete it.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                9. International Data Transfers
              </h2>
              <p>
                Our database is hosted in Mumbai, India, and our application
                runs on servers in Singapore. Error monitoring data goes to
                Sentry in the United States, and some other providers in Section
                4.2 may process data in other countries. These countries may
                have different data protection laws. We ensure that appropriate
                safeguards are in place to protect your information in
                accordance with this Privacy Policy.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                10. Data Retention
              </h2>
              <p>
                We retain your personal information for as long as necessary to:
              </p>
              <ul>
                <li>Provide our services to you</li>
                <li>Comply with legal obligations</li>
                <li>Resolve disputes and enforce our agreements</li>
                <li>
                  Maintain business records for tax and accounting purposes
                </li>
              </ul>
              {/* counsel: sign-off needed on the split: request, messages, files, chat excerpts and staff case notes deleted; decision explanations and refund and payment-hold reasons kept with the payment and refund records. */}
              <p>
                The personal content of a support case (your request text,
                messages, uploaded files, any booking chat excerpts saved to the
                case and our team&rsquo;s case notes) is deleted or anonymised
                180 days after the case and any appeal close, unless a legal
                hold applies or we need it for a legal claim. We keep the
                decision record (including its explanation), the reasons for any
                refund or payment hold, and the related payment and refund
                records as the law requires.
              </p>
              <p>
                When you delete your account, we will delete or anonymize your
                personal information within a reasonable timeframe, except where
                retention is required by law or for legitimate business
                purposes.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                11. Third-Party Links
              </h2>
              <p>
                Our platform may contain links to third-party websites or
                services. We are not responsible for the privacy practices of
                these external sites. We encourage you to read the privacy
                policies of any third-party sites you visit.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                12. Changes to This Privacy Policy
              </h2>
              <p>
                We may update this Privacy Policy from time to time to reflect
                changes in our practices, technology, legal requirements, or
                other factors. We will notify you of any material changes by:
              </p>
              <ul>
                <li>Posting the updated policy on this page</li>
                <li>Updating the "Last Updated" date at the top</li>
                <li>
                  Sending you an email notification (for significant changes)
                </li>
                <li>Displaying a prominent notice on our platform</li>
              </ul>
              <p>
                Your continued use of our services after any changes indicates
                your acceptance of the updated Privacy Policy.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                13. Contact Us
              </h2>
              <p>
                If you have any questions, concerns, or requests regarding this
                Privacy Policy or our data practices, please contact us:
              </p>
              <CompanyDetails>
                <p>
                  <strong>Contact Form:</strong>{" "}
                  <a
                    href="/contactus"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    Contact Us
                  </a>
                </p>
              </CompanyDetails>

              <Separator className="my-6" />

              <div className="bg-secondary border border-border p-6 rounded-lg mt-8">
                <h3 className="text-lg font-semibold mb-2">
                  Your Privacy Matters
                </h3>
                <p className="text-sm">
                  We are committed to protecting your privacy and handling your
                  data responsibly. If you have any concerns about how your
                  information is being used, please don't hesitate to reach out
                  to us. We're here to help and ensure your experience on
                  Familiarise is safe and secure.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
