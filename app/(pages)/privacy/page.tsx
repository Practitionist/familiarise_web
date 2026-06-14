"use client";

import { Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="py-16 md:py-24">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="text-center mb-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-6">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
              {PAGE_META.privacy.title}
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              {PAGE_META.privacy.description}
            </p>
            <p className="text-sm text-muted-foreground mt-4">
              Last updated: {POLICY_DATES.privacyLastUpdated}
            </p>
          </div>

          {/* Content */}
          <div className="prose prose-lg max-w-none">
            {/* 1. Introduction */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">1. Introduction</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  Welcome to Familiarise, operated by {COMPANY_INFO.name}{" "}
                  (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;).
                  Familiarise is a platform that connects Students with
                  experienced Consultants for personalised guidance and learning.
                  We are committed to protecting your privacy and handling your
                  personal data with care and transparency.
                </p>
                <p className="text-lg leading-relaxed">
                  This Privacy Policy explains how we collect, use, disclose, and
                  safeguard your information when you use the Familiarise
                  platform, including our website and related services. This
                  policy is drafted in compliance with the Digital Personal Data
                  Protection Act, 2023 (DPDP Act) and other applicable Indian
                  laws.
                </p>
                <p className="text-lg leading-relaxed">
                  By accessing or using Familiarise, you consent to the
                  collection and use of your information as described in this
                  Privacy Policy. If you do not agree with the terms of this
                  policy, please do not access or use our platform.
                </p>
              </CardContent>
            </Card>

            {/* 2. Information We Collect */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  2. Information We Collect
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Account Information
                  </h3>
                  <p className="text-lg leading-relaxed mb-3">
                    When you create an account on Familiarise, we collect
                    information that you provide directly, including:
                  </p>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>Full name and display name</li>
                    <li>Email address</li>
                    <li>Phone number</li>
                    <li>Profile picture</li>
                    <li>
                      Professional qualifications and expertise (for
                      Consultants)
                    </li>
                    <li>
                      Educational background and learning interests (for
                      Students)
                    </li>
                    <li>Bio and profile description</li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Service Usage Information
                  </h3>
                  <p className="text-lg leading-relaxed mb-3">
                    When you use Familiarise, we collect information related to
                    your activities on the platform, including:
                  </p>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Session bookings, scheduling details, and history
                    </li>
                    <li>
                      Messages and communications between Students and
                      Consultants
                    </li>
                    <li>Reviews, ratings, and feedback</li>
                    <li>
                      Search queries and browsing activity within the platform
                    </li>
                    <li>
                      Content you create, upload, or share on the platform
                    </li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Automatically Collected Information
                  </h3>
                  <p className="text-lg leading-relaxed mb-3">
                    When you access Familiarise, we automatically collect certain
                    technical information, including:
                  </p>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Device type, operating system, and browser information
                    </li>
                    <li>IP address and approximate location</li>
                    <li>
                      Usage patterns, page views, and feature interactions
                    </li>
                    <li>Referral URLs and navigation paths</li>
                    <li>Cookies and similar tracking technologies</li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Payment Information
                  </h3>
                  <p className="text-lg leading-relaxed">
                    Payment processing on Familiarise is handled by Razorpay,
                    our third-party payment processor. We do not directly store
                    your complete payment card details. Razorpay collects and
                    processes your payment information in accordance with PCI DSS
                    standards. We receive limited transaction information such as
                    transaction IDs, payment status, and amounts for our records.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 3. How We Use Your Information */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  3. How We Use Your Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Service Delivery
                  </h3>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Creating and managing your Familiarise account
                    </li>
                    <li>
                      Facilitating connections between Students and Consultants
                    </li>
                    <li>Processing session bookings and scheduling</li>
                    <li>
                      Enabling communication features on the platform
                    </li>
                    <li>Processing payments and managing transactions</li>
                    <li>
                      Providing customer support and resolving issues
                    </li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Platform Improvement
                  </h3>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Analysing usage patterns to improve features and user
                      experience
                    </li>
                    <li>Developing new features and services</li>
                    <li>Conducting research and analytics</li>
                    <li>Testing and debugging platform functionality</li>
                    <li>
                      Personalising your experience on Familiarise
                    </li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">Communication</h3>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Sending service-related notifications and updates
                    </li>
                    <li>Responding to your inquiries and requests</li>
                    <li>
                      Sending promotional communications (with your consent)
                    </li>
                    <li>
                      Delivering important policy and platform updates
                    </li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Legal and Safety
                  </h3>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      Complying with applicable laws and regulations
                    </li>
                    <li>
                      Enforcing our Terms of Service and other policies
                    </li>
                    <li>
                      Detecting, preventing, and addressing fraud or security
                      issues
                    </li>
                    <li>
                      Protecting the rights, property, and safety of our users
                      and the public
                    </li>
                  </ul>
                </div>
              </CardContent>
            </Card>

            {/* 4. Information Sharing */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  4. Information Sharing
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-lg leading-relaxed">
                  We do not sell your personal data. We may share your
                  information in the following circumstances:
                </p>

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    With Other Users
                  </h3>
                  <p className="text-lg leading-relaxed">
                    When you use Familiarise, certain information is shared
                    between Students and Consultants to facilitate the service.
                    For example, when a Student books a session with a
                    Consultant, relevant profile information, booking details,
                    and communications are shared between the parties.
                    Consultants can view Student profiles and session details,
                    and Students can view Consultant profiles, ratings, and
                    qualifications.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    With Service Providers
                  </h3>
                  <p className="text-lg leading-relaxed mb-3">
                    We work with trusted third-party service providers who assist
                    us in operating Familiarise. These providers have access to
                    your information only as necessary to perform their services
                    and are obligated to protect your data. Our key service
                    providers include:
                  </p>
                  <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                    <li>
                      <strong>Razorpay</strong> &mdash; Payment processing and
                      transaction management
                    </li>
                    <li>
                      <strong>GetStream</strong> &mdash; Real-time messaging and
                      communication features
                    </li>
                    <li>
                      <strong>Hosting and infrastructure providers</strong>{" "}
                      &mdash; Cloud storage and computing services
                    </li>
                    <li>
                      <strong>Analytics providers</strong> &mdash; Platform usage
                      analytics and performance monitoring
                    </li>
                  </ul>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    For Legal Requirements
                  </h3>
                  <p className="text-lg leading-relaxed">
                    We may disclose your information if required to do so by law
                    or in response to valid legal requests by public authorities,
                    including to meet national security or law enforcement
                    requirements, comply with a court order or legal process,
                    protect and defend our rights or property, or prevent or
                    investigate possible wrongdoing in connection with the
                    platform.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Business Transfers
                  </h3>
                  <p className="text-lg leading-relaxed">
                    In the event of a merger, acquisition, reorganisation, or
                    sale of all or a portion of our assets, your personal data
                    may be transferred as part of that transaction. We will
                    notify you via email and/or a prominent notice on our
                    platform of any change in ownership or use of your personal
                    data, as well as any choices you may have regarding your
                    data.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 5. Data Security */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">5. Data Security</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  We take the security of your personal data seriously and
                  implement appropriate technical and organisational measures to
                  protect it. Our security practices include:
                </p>
                <ul className="list-disc pl-6 space-y-2 text-lg leading-relaxed">
                  <li>
                    <strong>Encryption</strong> &mdash; Data is encrypted in
                    transit using TLS/SSL and at rest using industry-standard
                    encryption protocols
                  </li>
                  <li>
                    <strong>PCI Compliance</strong> &mdash; Payment processing
                    through Razorpay adheres to PCI DSS standards to ensure the
                    security of financial data
                  </li>
                  <li>
                    <strong>Access Controls</strong> &mdash; Strict access
                    controls and authentication mechanisms limit access to
                    personal data to authorised personnel only
                  </li>
                  <li>
                    <strong>Regular Audits</strong> &mdash; We conduct regular
                    security assessments and audits to identify and address
                    potential vulnerabilities
                  </li>
                  <li>
                    <strong>Incident Response</strong> &mdash; We maintain an
                    incident response plan to promptly address any data security
                    breaches, including notification to affected users and
                    relevant authorities within the timeframes required by law
                  </li>
                </ul>
                <p className="text-lg leading-relaxed">
                  While we strive to protect your personal data, no method of
                  transmission over the Internet or electronic storage is
                  completely secure. We cannot guarantee absolute security, but
                  we are committed to implementing and maintaining reasonable
                  safeguards.
                </p>
              </CardContent>
            </Card>

            {/* 6. Cookies and Tracking */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  6. Cookies and Tracking
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-lg leading-relaxed">
                  Familiarise uses cookies and similar tracking technologies to
                  enhance your experience on our platform. The types of cookies
                  we use include:
                </p>

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Essential Cookies
                  </h3>
                  <p className="text-lg leading-relaxed">
                    These cookies are necessary for the platform to function
                    properly. They enable core features such as authentication,
                    session management, and security. You cannot opt out of
                    essential cookies as they are required for the platform to
                    operate.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Functional Cookies
                  </h3>
                  <p className="text-lg leading-relaxed">
                    These cookies remember your preferences and settings to
                    provide a more personalised experience. They may include
                    language preferences, display settings, and other
                    customisation options.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Analytics Cookies
                  </h3>
                  <p className="text-lg leading-relaxed">
                    These cookies help us understand how users interact with
                    Familiarise by collecting and reporting usage information
                    anonymously. This data helps us improve the platform and
                    optimise the user experience.
                  </p>
                </div>

                <p className="text-lg leading-relaxed">
                  You can manage your cookie preferences through your browser
                  settings. Please note that disabling certain cookies may affect
                  the functionality of the platform.
                </p>
              </CardContent>
            </Card>

            {/* 7. Your Rights */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">7. Your Rights</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-lg leading-relaxed">
                  As a user of Familiarise, you have the following rights
                  regarding your personal data:
                </p>

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Access and Correction
                  </h3>
                  <p className="text-lg leading-relaxed">
                    You have the right to access the personal data we hold about
                    you and request corrections if any information is inaccurate
                    or incomplete. You can update most of your information
                    directly through your Familiarise account settings.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Data Deletion
                  </h3>
                  <p className="text-lg leading-relaxed">
                    You may request the deletion of your personal data by
                    contacting us. We will process your request in accordance
                    with applicable laws, subject to any legal obligations that
                    require us to retain certain information.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Data Portability
                  </h3>
                  <p className="text-lg leading-relaxed">
                    You have the right to request a copy of your personal data in
                    a structured, commonly used, and machine-readable format. You
                    may also request that we transfer your data directly to
                    another service provider where technically feasible.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Communication Preferences
                  </h3>
                  <p className="text-lg leading-relaxed">
                    You can opt out of promotional communications at any time by
                    using the unsubscribe link in our emails or adjusting your
                    notification preferences in your account settings. Please
                    note that you may still receive essential service-related
                    communications.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Grievance Redressal
                  </h3>
                  <p className="text-lg leading-relaxed">
                    If you have any complaints or concerns about how your
                    personal data is being processed, you may contact our
                    Grievance Officer (details provided in the Contact Us section
                    below). If you are not satisfied with our response, you have
                    the right to lodge a complaint with the Data Protection Board
                    of India established under the DPDP Act, 2023.
                  </p>
                </div>

                <p className="text-lg leading-relaxed">
                  To exercise any of these rights, please contact us at{" "}
                  <a
                    href={getMailtoLink()}
                    className="text-primary hover:underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                  .
                </p>
              </CardContent>
            </Card>

            {/* 8. Compliance with Indian Law */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  8. Compliance with Indian Law
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-lg leading-relaxed">
                  Familiarise is operated by {COMPANY_INFO.name}, a company
                  registered in India. We are committed to complying with all
                  applicable Indian data protection laws and regulations,
                  including:
                </p>

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Digital Personal Data Protection Act, 2023 (DPDP Act)
                  </h3>
                  <p className="text-lg leading-relaxed">
                    We process personal data in accordance with the DPDP Act,
                    2023. This includes ensuring that all data processing is
                    carried out for lawful purposes with the consent of the Data
                    Principal (you), and that appropriate security safeguards are
                    in place to protect your personal data.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Consent-Based Processing
                  </h3>
                  <p className="text-lg leading-relaxed">
                    We collect and process your personal data based on your
                    informed consent. You provide consent when you create an
                    account, use our services, or interact with our platform. You
                    may withdraw your consent at any time by contacting us,
                    though this may affect your ability to use certain features
                    of Familiarise.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    72-Hour Breach Notification
                  </h3>
                  <p className="text-lg leading-relaxed">
                    In the event of a personal data breach that is likely to
                    cause harm to Data Principals, we will notify the Data
                    Protection Board of India and affected users within 72 hours
                    of becoming aware of the breach, as required by the DPDP Act.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Data Principal Rights
                  </h3>
                  <p className="text-lg leading-relaxed">
                    Under the DPDP Act, you (as a Data Principal) have the right
                    to access your personal data, request correction and erasure,
                    seek grievance redressal, and nominate another person to
                    exercise your rights in the event of your death or
                    incapacity.
                  </p>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xl font-semibold mb-3">
                    Grievance Officer
                  </h3>
                  <p className="text-lg leading-relaxed">
                    In accordance with the DPDP Act, 2023, we have appointed a
                    Grievance Officer to address your concerns regarding the
                    processing of your personal data. The Grievance Officer can
                    be reached at{" "}
                    <a
                      href={getMailtoLink()}
                      className="text-primary hover:underline"
                    >
                      {COMPANY_INFO.email}
                    </a>
                    . We will acknowledge your grievance within 24 hours and
                    endeavour to resolve it within 30 days.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 9. Data Retention */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">9. Data Retention</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  We retain your personal data only for as long as necessary to
                  fulfil the purposes for which it was collected, including to
                  satisfy any legal, accounting, or reporting requirements.
                </p>
                <p className="text-lg leading-relaxed">
                  When determining the appropriate retention period, we consider
                  the amount, nature, and sensitivity of the personal data, the
                  potential risk of harm from unauthorised use or disclosure, the
                  purposes for which we process the data, and applicable legal
                  requirements.
                </p>
                <p className="text-lg leading-relaxed">
                  When your personal data is no longer needed, we will securely
                  delete or anonymise it. If deletion is not immediately possible
                  (for example, because your data is stored in backup archives),
                  we will securely store your data and isolate it from further
                  processing until deletion is possible.
                </p>
              </CardContent>
            </Card>

            {/* 10. Children's Privacy */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  10. Children&apos;s Privacy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  Familiarise is not intended for use by children under the age
                  of 13. We do not knowingly collect personal data from children
                  under 13. If we become aware that we have collected personal
                  data from a child under 13, we will take steps to delete that
                  information promptly.
                </p>
                <p className="text-lg leading-relaxed">
                  If you are a parent or guardian and believe that your child has
                  provided us with personal data without your consent, please
                  contact us at{" "}
                  <a
                    href={getMailtoLink()}
                    className="text-primary hover:underline"
                  >
                    {COMPANY_INFO.email}
                  </a>{" "}
                  and we will take appropriate action.
                </p>
              </CardContent>
            </Card>

            {/* 11. Changes to This Privacy Policy */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">
                  11. Changes to This Privacy Policy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  We may update this Privacy Policy from time to time to reflect
                  changes in our practices, technology, legal requirements, or
                  other factors. When we make material changes, we will notify
                  you by posting the updated policy on this page with a revised
                  &quot;Last updated&quot; date and, where appropriate, provide
                  additional notice such as an email notification.
                </p>
                <p className="text-lg leading-relaxed">
                  We encourage you to review this Privacy Policy periodically to
                  stay informed about how we are protecting your data. Your
                  continued use of Familiarise after any changes to this policy
                  constitutes your acceptance of the updated terms.
                </p>
              </CardContent>
            </Card>

            {/* 12. Contact Us */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-2xl">12. Contact Us</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg leading-relaxed">
                  If you have any questions, concerns, or requests regarding this
                  Privacy Policy or our data practices, please contact us:
                </p>
                <div className="space-y-3 text-lg leading-relaxed">
                  <p>
                    <strong>Company:</strong> {COMPANY_INFO.name}
                  </p>
                  <p>
                    <strong>Email:</strong>{" "}
                    <a
                      href={getMailtoLink()}
                      className="text-primary hover:underline"
                    >
                      {COMPANY_INFO.email}
                    </a>
                  </p>
                  <p>
                    <strong>Support Email:</strong>{" "}
                    <a
                      href={getMailtoLink(COMPANY_INFO.supportEmail)}
                      className="text-primary hover:underline"
                    >
                      {COMPANY_INFO.supportEmail}
                    </a>
                  </p>
                  <p>
                    <strong>Contact Form:</strong>{" "}
                    <a
                      href="/contactus"
                      className="text-primary hover:underline"
                    >
                      Visit our Contact Page
                    </a>
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Your Privacy Matters Callout */}
            <Card className="mb-8 border-primary/20 bg-primary/5">
              <CardContent className="pt-6">
                <div className="text-center space-y-4">
                  <Shield className="w-12 h-12 text-primary mx-auto" />
                  <h3 className="text-2xl font-bold">Your Privacy Matters</h3>
                  <p className="text-lg leading-relaxed max-w-2xl mx-auto">
                    At Familiarise, we believe that trust is the foundation of
                    our platform. We are committed to being transparent about our
                    data practices and giving you control over your personal
                    information. If you ever have questions or concerns, do not
                    hesitate to reach out to us.
                  </p>
                  <div className="pt-2">
                    <a
                      href={getMailtoLink()}
                      className="inline-flex items-center text-primary hover:underline text-lg font-medium"
                    >
                      Contact us about your privacy
                    </a>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
