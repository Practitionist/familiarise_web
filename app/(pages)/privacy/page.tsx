"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Shield } from "lucide-react";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

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
                <li>Usage data (pages visited, time spent, click patterns)</li>
                <li>
                  Location information (approximate location based on IP
                  address)
                </li>
                <li>Cookies and similar tracking technologies</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                2.3 Session and Communication Data
              </h3>
              <p>During your use of our services, we may collect:</p>
              <ul>
                <li>Chat messages and communications between users</li>
                <li>
                  Video conference metadata (session duration, participants)
                </li>
                <li>Course materials and content uploads</li>
                <li>Ratings and reviews</li>
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
                <li>Analyze platform usage and performance</li>
                <li>Improve user experience and features</li>
                <li>Develop new services and functionalities</li>
                <li>Conduct research and analytics</li>
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
                3.5 Itemised Purpose &amp; Retention Schedule (DPDP Act 2023
                &amp; Rule 3)
              </h3>
              <p>
                In accordance with Section 5 of the Digital Personal Data
                Protection Act, 2023 (&ldquo;DPDP Act&rdquo;) and Rule 3 of the
                Digital Personal Data Protection Rules, 2025, the table below
                itemises the personal data we process, the specific purpose and
                canonical purpose code, and the applicable retention period:
              </p>
              <div className="overflow-x-auto my-4">
                <table className="min-w-full text-sm border border-border">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-2 text-left border-b border-border">
                        Data Category
                      </th>
                      <th className="p-2 text-left border-b border-border">
                        Specific Purpose &amp; Code
                      </th>
                      <th className="p-2 text-left border-b border-border">
                        Tier &amp; Retention Period
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Account &amp; Identity</strong> (name, email,
                        phone, timezone, role, professional bio/credentials,
                        date of birth for 18+ age verification under DPDP
                        &sect;9 / Fourth Schedule Part B Item 6)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Service &amp; Account</strong> {"("}
                        <code>PRIMARY_PROCESSING</code>
                        {")"} — Create and operate your account, authenticate
                        sessions, and verify adult eligibility.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Core (Required)</strong> — Retained while
                        account is active; scrubbed on account erasure
                        (&sect;12).
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Bookings &amp; Scheduling</strong> (selected
                        slots, consultation/subscription/class/webinar bookings,
                        request notes)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Session Booking</strong> {"("}
                        <code>SESSION_BOOKING</code>
                        {")"} — Schedule, manage, and deliver 1:1 consultations,
                        subscriptions, webinars, and classes.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Core (Required)</strong> — Free-text notes
                        scrubbed on erasure; appointment delivery records linked
                        to tax invoices retained per statutory tax law.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Live Video &amp; Chat</strong> (user ID, display
                        name, avatar, session room participation)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Video &amp; Chat</strong> {"("}
                        <code>STREAM_DATA_PROCESSING</code>
                        {")"} — Real-time video calls and messaging via
                        GetStream.io.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Core (Required)</strong> — Active account
                        lifetime; access and tokens revoked upon erasure.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Payments, Payouts &amp; Tax Records</strong>{" "}
                        (Razorpay order/payment IDs, invoices, consultant
                        earnings, payouts, PAN/TDS &amp; GST ledger rows)
                      </td>
                      <td className="p-2 align-top">
                        <strong>
                          Financial Settlement &amp; Statutory Tax
                        </strong>{" "}
                        {"("}
                        <code>PRIMARY_PROCESSING</code> &amp; DPDP
                        &sect;12(3)/&sect;8(7)(b)
                        {")"}
                      </td>
                      <td className="p-2 align-top">
                        <strong>Statutory Retention</strong> — Retained for 7–8
                        years under the Income Tax Act, 1961 (&sect;44AA / Rule
                        6F) and CGST Act, 2017 (&sect;36) with profile identity
                        tombstoned to a pseudonymous hash after erasure.
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Security &amp; Error Diagnostics</strong>{" "}
                        (one-way HMAC-SHA256 virtual token{" "}
                        <code>ust_&lt;hash&gt;</code>, trace IDs, error stack
                        traces, security audit logs)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Security Safeguards &amp; Support</strong> (DPDP
                        &sect;8(4)–(5) &amp; Rule 6) — Detect deadlocks, failed
                        checkouts, and security incidents without exposing raw
                        PII.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Statutory Security</strong> — 30–90 days in
                        Sentry; 1 year minimum for security/processing logs
                        under DPDP Rule 8(3).
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2 align-top">
                        <strong>Marketing &amp; Product Analytics</strong>{" "}
                        (promotional email preferences, product interaction
                        telemetry)
                      </td>
                      <td className="p-2 align-top">
                        <strong>Marketing &amp; Analytics</strong> {"("}
                        <code>MARKETING_COMMS</code>, <code>ANALYTICS</code>
                        {")"} — Send product updates/offers and measure feature
                        usage.
                      </td>
                      <td className="p-2 align-top">
                        <strong>Optional</strong> — Until withdrawn via 1-click
                        toggle in Settings &rarr; Account.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

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

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.2 With Service Providers (Data Processors)
              </h3>
              <p>
                We share limited data with trusted third-party Data Processors
                under contractual data-processing and confidentiality
                obligations:
              </p>
              <ul>
                <li>
                  <strong>Razorpay / Stripe:</strong> Payment processing,
                  refunds, consultant payouts, and transaction management
                </li>
                <li>
                  <strong>GetStream.io:</strong> Video conferencing and
                  real-time chat communication {"("}
                  <code>STREAM_DATA_PROCESSING</code>
                  {")"}
                </li>
                <li>
                  <strong>
                    Cloud Database &amp; Storage (Supabase / Neon):
                  </strong>{" "}
                  Encrypted database hosting, verification document storage, and
                  backups
                </li>
                <li>
                  <strong>
                    Email &amp; Notification Providers (Resend / Novu):
                  </strong>{" "}
                  Transactional booking notifications and consented marketing
                  emails
                </li>
                <li>
                  <strong>
                    Sentry (Functional Software, Inc. — United States,{" "}
                    <code>us.sentry.io</code>):
                  </strong>{" "}
                  Application error monitoring, distributed tracing, and
                  reliability diagnostics. Under DPDP Rule 6(1)(a)
                  de-identification safeguards, Familiarise configures{" "}
                  <code>sendDefaultPii: false</code> and never transmits your
                  name, email, phone number, or unmasked page text to Sentry;
                  events are tagged solely with a one-way salted HMAC-SHA256
                  virtual token (<code>ust_&lt;24-hex-chars&gt;</code>) and
                  retained for 30–90 days to help our support and engineering
                  teams diagnose technical issues you report.
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
                We use cookies and similar tracking technologies to enhance your
                experience:
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                6.1 Types of Cookies
              </h3>
              <ul>
                <li>
                  <strong>Essential Cookies:</strong> Required for the platform
                  to function properly
                </li>
                <li>
                  <strong>Functional Cookies:</strong> Remember your preferences
                  and settings
                </li>
                <li>
                  <strong>Analytics Cookies:</strong> Help us understand how you
                  use our platform
                </li>
                <li>
                  <strong>Marketing Cookies:</strong> Track marketing campaign
                  effectiveness
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                6.2 Cookie Management
              </h3>
              <p>
                You can control cookies through your browser settings. However,
                disabling certain cookies may affect the functionality of our
                platform. Most browsers allow you to refuse cookies or delete
                existing cookies.
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
                  Opt-out of marketing emails by clicking "unsubscribe" in any
                  email
                </li>
                <li>
                  Manage notification preferences in your account settings
                </li>
                <li>
                  Note: You will still receive essential transactional emails
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.4 Data Portability &amp; Summary of Personal Data (DPDP
                &sect;11)
              </h3>
              <ul>
                <li>
                  Download a machine-readable JSON summary of your personal
                  data, booking history, payment records, consent artifacts, and
                  the list of Data Processors with whom your data has been
                  shared directly from <strong>Settings &rarr; Account</strong>{" "}
                  (&ldquo;Download my data &amp; processor summary&rdquo;)
                </li>
                <li>
                  Transfer your data to another service (where technically
                  feasible)
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.5 Consent Withdrawal, Grievance Redressal &amp; Data
                Protection Board of India (DPDP &sect;6, &sect;12, &sect;13
                &amp; &sect;14)
              </h3>
              <ul>
                <li>
                  <strong>Withdraw Optional Consents Anytime:</strong> You can
                  grant or withdraw optional consents (Marketing Communications{" "}
                  <code>MARKETING_COMMS</code> and Analytics{" "}
                  <code>ANALYTICS</code>) with one click in{" "}
                  <strong>Dashboard &rarr; Settings &rarr; Account</strong>{" "}
                  (&ldquo;Data consent&rdquo;) without affecting your core
                  account access.
                </li>
                <li>
                  <strong>Withdraw Core Consent &amp; Erase Account:</strong>{" "}
                  Core platform consents (<code>PRIMARY_PROCESSING</code>,{" "}
                  <code>SESSION_BOOKING</code>,{" "}
                  <code>STREAM_DATA_PROCESSING</code>) are required to operate
                  your account and deliver bookings. Under DPDP &sect;6(4)–(6)
                  and &sect;12, you may withdraw core consent at any time by
                  selecting{" "}
                  <strong>Withdraw core consent &amp; delete account</strong> in{" "}
                  <strong>Settings &rarr; Account</strong>. If you have active
                  upcoming sessions or unsettled payouts/disputes, we will guide
                  you to complete or cancel them first; upon erasure, your
                  personal identifiers are permanently scrubbed while statutory
                  tax and financial records are retained under Indian tax law.
                </li>
                <li>
                  <strong>Grievance Officer &amp; Statutory SLA:</strong> You
                  may file a grievance in{" "}
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
                  {". "}Grievances receive an immediate ticket reference, are
                  acknowledged within 24 hours, and are resolved within 15 days.
                </li>
                <li>
                  <strong>Right to Approach the Data Protection Board:</strong>{" "}
                  If your grievance is not resolved within the statutory period
                  or you are dissatisfied with the resolution, you have the
                  right under Section 13(3) and Section 27 of the DPDP Act, 2023
                  to make a complaint to the{" "}
                  <strong>Data Protection Board of India (DPBI)</strong>.
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                8. Children's Privacy
              </h2>
              <p>
                Under the Digital Personal Data Protection Act, 2023, a child is
                anyone who has not completed eighteen years of age. Our services
                are not intended for children, and we do not knowingly collect
                personal information from anyone under 18. We ask for your date
                of birth during onboarding solely to confirm that you are not a
                child — a purpose expressly permitted by Part B, item 6 of the
                Fourth Schedule to the Digital Personal Data Protection Rules,
                2025.
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
                Your information may be transferred to and processed in
                countries other than your country of residence. These countries
                may have different data protection laws. We ensure that
                appropriate safeguards are in place to protect your information
                in accordance with this Privacy Policy.
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
                  <strong>Contact Form:</strong>{" "}
                  <a
                    href="/contactus"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    Contact Us
                  </a>
                </p>
              </div>

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
