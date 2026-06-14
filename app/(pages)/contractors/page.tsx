"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Users } from "lucide-react";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function ContractorAgreementPage() {
  return (
    <section className="w-full py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6 lg:px-8">
        {/* Hero Section */}
        <div className="text-center mb-16">
          <div className="flex justify-center mb-6">
            <Users className="h-20 w-20 text-primary" />
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            {PAGE_META.contractors.title}
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-4xl mx-auto leading-relaxed">
            {PAGE_META.contractors.description}
          </p>
        </div>

        <div className="max-w-6xl mx-auto">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl md:text-3xl">
                Independent Contractor Agreement
              </CardTitle>
              <p className="text-base text-muted-foreground">
                Last Updated: {POLICY_DATES.contractorLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-lg prose-slate max-w-none dark:prose-invert">
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                1. Introduction
              </h2>
              <p className="text-lg leading-relaxed">
                This Independent Contractor Agreement (&quot;Agreement&quot;) governs
                the relationship between {COMPANY_INFO.name} (&quot;Company&quot;,
                &quot;we&quot;, &quot;us&quot;) and independent service providers
                (&quot;Consultants&quot;, &quot;you&quot;) who offer educational
                services, consultations, classes, webinars, or other professional
                services through the Familiarise platform (the &quot;Platform&quot;).
              </p>
              <p className="text-lg leading-relaxed">
                Familiarise is operated by {COMPANY_INFO.name}. By registering as
                a Consultant on Familiarise, you acknowledge that you have read,
                understood, and agree to be bound by this Agreement.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                2. Nature of Relationship
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.1 Independent Contractor Status
              </h3>
              <p className="text-lg leading-relaxed">
                You are an independent contractor and not an employee, agent,
                partner, or joint venture participant of {COMPANY_INFO.name} or
                Familiarise. Nothing in this Agreement creates or is intended to
                create an employer-employee relationship between you and the
                Platform.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.2 No Platform Control Over Service Delivery
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform does not and shall not:
              </p>
              <ul className="text-lg space-y-2">
                <li>Control the manner, method, or means by which you deliver your services</li>
                <li>Set your working hours, schedule, or location of work</li>
                <li>Provide you with tools, equipment, or workspace</li>
                <li>Require exclusivity &mdash; you are free to offer services through other platforms or independently</li>
                <li>Provide employment benefits, insurance, retirement plans, or other employee protections</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                2.3 Your Autonomy
              </h3>
              <p className="text-lg leading-relaxed">
                You retain full control over how you deliver your services. You
                determine your own teaching methods, content, pricing, availability,
                and service terms, subject to Familiarise&apos;s community guidelines
                and terms of service.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                3. Consultant Obligations
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.1 Qualifications and Representation
              </h3>
              <ul className="text-lg space-y-2">
                <li>Provide accurate and truthful information about your qualifications, expertise, and experience</li>
                <li>Maintain any necessary professional licenses, certifications, or credentials relevant to your services</li>
                <li>Not misrepresent your background, skills, or the nature of your services</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.2 Professional Conduct
              </h3>
              <ul className="text-lg space-y-2">
                <li>Deliver services professionally and in a timely manner</li>
                <li>Honor confirmed bookings or provide reasonable notice for cancellations</li>
                <li>Maintain respectful and appropriate communication with Students</li>
                <li>Protect the confidentiality of Student information</li>
                <li>Not engage in harassment, discrimination, or any unlawful conduct</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.3 Content Standards
              </h3>
              <ul className="text-lg space-y-2">
                <li>Only upload and share content that you own or have the right to use</li>
                <li>Ensure your content does not infringe on any third-party intellectual property rights</li>
                <li>Not upload illegal, harmful, misleading, or offensive content</li>
                <li>Comply with all applicable laws regarding the content you provide</li>
              </ul>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                4. Platform Obligations
              </h2>
              <p className="text-lg leading-relaxed">
                {COMPANY_INFO.name} agrees to:
              </p>
              <ul className="text-lg space-y-2">
                <li>Provide and maintain the Familiarise platform for service delivery, including booking, scheduling, and communication tools</li>
                <li>Process payments securely through our payment partner (Razorpay)</li>
                <li>Remit your earnings according to the agreed settlement schedule after deducting the platform service fee</li>
                <li>Provide reasonable support for platform-related issues</li>
                <li>Maintain the security and integrity of the platform</li>
                <li>Handle user disputes in accordance with our published policies</li>
              </ul>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                5. Payment Terms
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                5.1 Pricing
              </h3>
              <p className="text-lg leading-relaxed">
                You set your own prices for the services you offer through
                Familiarise. The Platform charges a service fee on each transaction,
                which is displayed to Students as part of the total price. You may
                adjust your pricing at any time, subject to any active bookings or
                subscriptions.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                5.2 Settlement
              </h3>
              <ul className="text-lg space-y-2">
                <li>Earnings are calculated after deducting the platform service fee and any applicable payment gateway charges</li>
                <li>Payouts are processed according to the platform&apos;s published settlement schedule</li>
                <li>Payments are made to your registered bank account via Razorpay</li>
                <li>Payouts are contingent on successful service delivery and compliance with this Agreement</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                5.3 Refunds and Chargebacks
              </h3>
              <p className="text-lg leading-relaxed">
                If a Student is issued a refund for your services in accordance
                with our{" "}
                <a href="/refund" className="text-blue-600 hover:underline">
                  Cancellation &amp; Refund Policy
                </a>
                , the corresponding amount will be deducted from your future
                earnings or recovered from your account. You agree to cooperate
                with the Platform in resolving refund-related disputes.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                6. Tax Responsibilities
              </h2>
              <p className="text-lg leading-relaxed">
                As an independent contractor, you are solely responsible for:
              </p>
              <ul className="text-lg space-y-2">
                <li><strong>Income Tax:</strong> Reporting and paying all applicable income taxes on earnings received through Familiarise</li>
                <li><strong>GST:</strong> Registering for and remitting Goods and Services Tax if your annual turnover exceeds the applicable threshold under Indian law (currently Rs 20 lakh for services)</li>
                <li><strong>TDS:</strong> The Platform may deduct Tax Deducted at Source (TDS) on payments as required under the Income Tax Act, 1961</li>
                <li><strong>Other Taxes:</strong> Any other taxes, duties, or levies applicable in your jurisdiction</li>
              </ul>
              <p className="text-lg leading-relaxed">
                The Platform does not provide tax advice. You are strongly
                encouraged to consult a qualified tax professional regarding your
                tax obligations. The Platform does not collect or remit taxes on
                your behalf except where legally required (such as TDS).
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                7. Intellectual Property
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                7.1 Your Content
              </h3>
              <p className="text-lg leading-relaxed">
                You retain full ownership of the original educational content,
                course materials, and other intellectual property that you create
                and upload to Familiarise. By uploading content, you grant
                {" "}{COMPANY_INFO.name} a non-exclusive, worldwide, royalty-free
                license to use, display, reproduce, and distribute your content
                solely as necessary to operate and promote Familiarise and your
                services.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                7.2 Platform IP
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform&apos;s technology, design, trademarks, logos, and
                proprietary features are owned by {COMPANY_INFO.name}. You may not
                use, copy, or distribute our intellectual property without express
                written permission.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                7.3 License Termination
              </h3>
              <p className="text-lg leading-relaxed">
                Upon termination of this Agreement, the license granted to the
                Platform to use your content will terminate, except for content
                that has already been delivered to Students as part of completed
                transactions or that is required for legal or record-keeping
                purposes.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                8. Non-Circumvention
              </h2>
              <p className="text-lg leading-relaxed">
                All transactions for services discovered through or facilitated by
                Familiarise must be conducted through the Platform&apos;s payment
                system. You agree not to:
              </p>
              <ul className="text-lg space-y-2">
                <li>Solicit or accept payments from Students outside the Platform for services initially booked or discovered through Familiarise</li>
                <li>Redirect Students to external payment methods, personal websites, or competing platforms to circumvent the Platform&apos;s fee structure</li>
                <li>Share personal contact information with Students for the purpose of conducting off-platform transactions</li>
              </ul>
              <p className="text-lg leading-relaxed">
                Violation of this clause may result in immediate suspension or
                termination of your account, forfeiture of pending earnings, and
                any other remedies available to the Platform.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                9. Termination
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                9.1 Termination by Consultant
              </h3>
              <p className="text-lg leading-relaxed">
                You may terminate this Agreement at any time by deactivating your
                Consultant account on Familiarise. You must fulfill all confirmed
                bookings and outstanding obligations before termination takes effect.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                9.2 Termination by Platform
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform may suspend or terminate your account if you:
              </p>
              <ul className="text-lg space-y-2">
                <li>Violate this Agreement or the Platform&apos;s Terms &amp; Conditions</li>
                <li>Receive persistent negative reviews or complaints</li>
                <li>Engage in fraudulent, illegal, or unethical conduct</li>
                <li>Fail to deliver confirmed services without valid reason</li>
                <li>Circumvent the Platform&apos;s payment system</li>
                <li>Misrepresent your qualifications or services</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                9.3 Effect of Termination
              </h3>
              <ul className="text-lg space-y-2">
                <li>Pending earnings for completed services will be settled according to the regular schedule</li>
                <li>Earnings for disputed or incomplete services may be withheld pending resolution</li>
                <li>Your content will be removed from Familiarise within a reasonable timeframe</li>
                <li>Obligations that by their nature should survive termination (confidentiality, indemnification, IP licenses for completed transactions) will continue in effect</li>
              </ul>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                10. Liability and Indemnification
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                10.1 Platform Liability
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform provides technology services &quot;as is&quot; and does not
                guarantee a minimum level of bookings, earnings, or engagement.
                The Platform is not liable for disputes between you and Students,
                or for any indirect, incidental, or consequential damages arising
                from your use of Familiarise.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                10.2 Consultant Indemnification
              </h3>
              <p className="text-lg leading-relaxed">
                You agree to indemnify, defend, and hold harmless {COMPANY_INFO.name},
                its officers, directors, employees, and agents from any and all
                claims, damages, losses, liabilities, and expenses (including legal
                fees) arising from:
              </p>
              <ul className="text-lg space-y-2">
                <li>Your services, content, or conduct on Familiarise</li>
                <li>Your violation of this Agreement or applicable law</li>
                <li>Your infringement of any third-party rights</li>
                <li>Any claim by a Student related to the quality, accuracy, or delivery of your services</li>
                <li>Your failure to comply with tax obligations</li>
              </ul>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                11. Confidentiality
              </h2>
              <p className="text-lg leading-relaxed">
                Both parties agree to maintain the confidentiality of any
                proprietary or sensitive information shared during the course of
                this relationship. This includes but is not limited to:
              </p>
              <ul className="text-lg space-y-2">
                <li>Student personal information and session details</li>
                <li>Platform business strategies, algorithms, and proprietary data</li>
                <li>Financial information, including earnings and settlement details</li>
                <li>Any information designated as confidential by either party</li>
              </ul>
              <p className="text-lg leading-relaxed">
                This obligation survives termination of this Agreement.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                12. Dispute Resolution
              </h2>
              <p className="text-lg leading-relaxed">
                Any disputes arising from or relating to this Agreement shall be:
              </p>
              <ul className="text-lg space-y-2">
                <li>First attempted to be resolved through informal negotiation between the parties</li>
                <li>If unresolved within 30 days, referred to mediation</li>
                <li>Governed by the laws of {COMPANY_INFO.jurisdiction}</li>
                <li>Subject to the exclusive jurisdiction of courts in {COMPANY_INFO.jurisdiction}</li>
              </ul>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                13. Modifications
              </h2>
              <p className="text-lg leading-relaxed">
                We may update this Agreement from time to time. We will notify you
                of material changes by email and by posting the updated Agreement
                on this page with a revised &quot;Last Updated&quot; date. Your continued
                use of Familiarise after such changes constitutes acceptance of
                the updated terms. If you do not agree to the changes, you must
                stop using the Platform and terminate your account.
              </p>

              <Separator className="my-8" />

              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                14. Contact Us
              </h2>
              <p className="text-lg leading-relaxed">
                If you have any questions about this Contractor Agreement, please
                contact us:
              </p>
              <div className="bg-muted p-6 rounded-lg mt-6">
                <p className="text-lg">
                  <strong>Company:</strong> {COMPANY_INFO.name}
                </p>
                <p className="text-lg">
                  <strong>Email:</strong>{" "}
                  <a
                    href={getMailtoLink()}
                    className="text-blue-600 hover:underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                </p>
                <p className="text-lg">
                  <strong>Support:</strong>{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-blue-600 hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>
                </p>
                <p className="text-lg">
                  <strong>Contact Form:</strong>{" "}
                  <a
                    href="/contactus"
                    className="text-blue-600 hover:underline"
                  >
                    Contact Us
                  </a>
                </p>
              </div>

              <Separator className="my-8" />

              <div className="bg-blue-50 dark:bg-blue-950 p-8 rounded-lg mt-10">
                <h3 className="text-xl font-semibold mb-3">
                  Building Together
                </h3>
                <p className="text-base leading-relaxed">
                  We value the expertise and commitment of our Consultants. This
                  Agreement is designed to create a transparent, fair, and
                  mutually beneficial relationship. If you have questions or need
                  clarification on any aspect of this Agreement, our team is here
                  to help.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
