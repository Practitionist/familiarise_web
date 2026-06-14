"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FileText } from "lucide-react";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function TermsPage() {
  return (
    <section className="w-full py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6 lg:px-8">
        {/* Hero Section */}
        <div className="text-center mb-16">
          <div className="flex justify-center mb-6">
            <FileText className="h-20 w-20 text-primary" />
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            {PAGE_META.terms.title}
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-4xl mx-auto leading-relaxed">
            {PAGE_META.terms.description}
          </p>
        </div>

        <div className="max-w-6xl mx-auto">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-2xl md:text-3xl">Terms &amp; Conditions</CardTitle>
              <p className="text-base text-muted-foreground">
                Last Updated: {POLICY_DATES.termsLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-lg prose-slate max-w-none dark:prose-invert">
              {/* Section 1: Agreement to Terms */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                1. Agreement to Terms
              </h2>
              <p className="text-lg leading-relaxed">
                By accessing, browsing, or using Familiarise (the
                &quot;Platform&quot;), operated by {COMPANY_INFO.name}, you
                acknowledge that you have read, understood, and agree to be
                bound by these Terms and Conditions (&quot;Terms&quot;). If you
                do not agree to all of these Terms, you must immediately
                discontinue use of the Platform.
              </p>
              <p className="text-lg leading-relaxed">
                These Terms constitute a legally binding agreement between you
                (&quot;User,&quot; &quot;you,&quot; or &quot;your&quot;) and{" "}
                {COMPANY_INFO.name} (&quot;we,&quot; &quot;us,&quot; or
                &quot;our&quot;). By creating an account, making a purchase, or
                otherwise using the Platform, you consent to the collection and
                use of information as described in our{" "}
                <a href="/privacy" className="text-blue-600 hover:underline">
                  Privacy Policy
                </a>
                .
              </p>

              <Separator className="my-8" />

              {/* Section 2: Platform Description */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                2. Platform Description
              </h2>
              <p className="text-lg leading-relaxed">
                Familiarise is an educational technology platform that
                facilitates connections between independent consultants,
                educators, and subject matter experts (&quot;Consultants&quot;)
                and students and learners (&quot;Students&quot;). As a
                marketplace intermediary, Familiarise provides the technology
                infrastructure, payment processing, scheduling tools, and
                communication channels that enable Consultants and Students to
                discover each other and transact. We do not provide educational
                services directly. Consultants are independent professionals
                who offer their services through our Platform.
              </p>
              <p className="text-lg leading-relaxed">
                The quality, accuracy, legality, and appropriateness of
                Consultant services are the sole responsibility of the
                Consultants who provide them. Through Familiarise, Consultants
                may offer and Students may access the following types of
                services:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>1-on-1 Consultations</strong> &mdash; Private,
                  personalized sessions between a Student and a Consultant,
                  covering topics such as mentorship, career guidance, skill
                  development, and professional advice
                </li>
                <li>
                  <strong>Live Interactive Classes</strong> &mdash; Group
                  sessions led by a Consultant, allowing real-time interaction,
                  Q&amp;A, and collaborative learning among participants
                </li>
                <li>
                  <strong>Webinars and Workshops</strong> &mdash;
                  Consultant-hosted events on specialized topics, available to a
                  broader audience for knowledge sharing and professional
                  development
                </li>
                <li>
                  <strong>Subscription-Based Learning</strong> &mdash;
                  Recurring access plans that provide Students with ongoing
                  sessions, content, and resources from their chosen Consultants
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 3: User Accounts */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                3. User Accounts
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.1 Registration
              </h3>
              <p className="text-lg leading-relaxed">
                To access certain features of the Platform, you must create an
                account. During registration, you agree to:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Provide accurate, current, and complete information as
                  prompted by the registration form
                </li>
                <li>
                  Maintain and promptly update your account information to keep
                  it accurate and complete
                </li>
                <li>
                  Be at least 13 years of age to create an account; users under
                  18 must have parental or guardian consent and may not access
                  certain services designated for adults only
                </li>
                <li>Maintain only one account per person</li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.2 Responsibilities
              </h3>
              <p className="text-lg leading-relaxed">
                You are solely responsible for safeguarding your account
                credentials and for all activities that occur under your
                account. You agree to:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Keep your login credentials strictly confidential and not
                  share them with any third party
                </li>
                <li>
                  Notify us immediately at{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-blue-600 hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>{" "}
                  if you suspect any unauthorized access to or use of your
                  account
                </li>
                <li>
                  Accept responsibility for all actions taken through your
                  account, whether or not you authorized those actions
                </li>
                <li>
                  Log out of your account at the end of each session,
                  particularly when using shared or public devices
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                3.3 Termination
              </h3>
              <p className="text-lg leading-relaxed">
                We reserve the right to suspend or permanently terminate any
                account, at our sole discretion and without prior notice, if we
                determine that the account holder has violated these Terms,
                engaged in fraudulent or abusive activity, or poses a risk to
                the safety or integrity of the Platform or other users. You
                may also request deletion of your account at any time by
                contacting us. Upon termination, your right to access the
                Platform ceases immediately, though certain provisions of
                these Terms (including limitation of liability, indemnification,
                and dispute resolution) shall survive termination.
              </p>

              <Separator className="my-8" />

              {/* Section 4: User Roles and Responsibilities */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                4. User Roles and Responsibilities
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                4.1 Students
              </h3>
              <p className="text-lg leading-relaxed">
                As a Student on the Platform, you agree to the following
                obligations:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Punctuality:</strong> Attend all scheduled sessions,
                  classes, and webinars on time. Repeated no-shows may result
                  in account restrictions or forfeiture of session fees
                </li>
                <li>
                  <strong>Respectful Conduct:</strong> Treat all Consultants
                  and fellow Students with courtesy, professionalism, and
                  respect during all interactions on the Platform
                </li>
                <li>
                  <strong>Content Protection:</strong> Do not copy, reproduce,
                  share, distribute, or commercially exploit any paid content,
                  session materials, recordings, or proprietary resources
                  without explicit written authorization from the content owner
                </li>
                <li>
                  <strong>Payment Obligations:</strong> Complete all payments
                  for booked sessions, subscriptions, and services in a timely
                  manner through the Platform&apos;s designated payment system
                </li>
                <li>
                  <strong>Cancellation Compliance:</strong> Follow the
                  applicable cancellation and rescheduling policies. Failure to
                  cancel within the specified timeframe may result in loss of
                  fees
                </li>
                <li>
                  <strong>No Unauthorized Recording:</strong> Do not record,
                  screenshot, or capture any session, class, or webinar
                  content without obtaining prior consent from the Consultant
                  and all other participants
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                4.2 Consultants
              </h3>
              <p className="text-lg leading-relaxed">
                As a Consultant offering services through the Platform, you
                agree to the following obligations:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Accurate Credentials:</strong> Provide truthful,
                  verifiable information about your qualifications, experience,
                  certifications, and areas of expertise. Misrepresentation of
                  credentials is grounds for immediate termination
                </li>
                <li>
                  <strong>Professional Delivery:</strong> Deliver all sessions
                  and services in a professional, prepared, and timely manner.
                  Maintain a standard of quality consistent with the
                  expectations set in your profile and listing descriptions
                </li>
                <li>
                  <strong>Student Privacy:</strong> Do not share, disclose, or
                  misuse any Student personal information, session details, or
                  private communications outside the scope of the service
                  engagement
                </li>
                <li>
                  <strong>Pricing Compliance:</strong> Comply with all platform
                  policies regarding pricing, fee structures, and promotional
                  offers. Do not engage in deceptive pricing practices
                </li>
                <li>
                  <strong>Professional Conduct:</strong> Maintain appropriate
                  professional boundaries and conduct during all interactions
                  with Students, including refraining from discriminatory,
                  harassing, or inappropriate behaviour
                </li>
                <li>
                  <strong>No Off-Platform Solicitation:</strong> Do not
                  solicit, encourage, or facilitate any Student to conduct
                  transactions, payments, or communications outside the
                  Platform in order to circumvent platform fees or policies
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                4.3 Content Contributors
              </h3>
              <p className="text-lg leading-relaxed">
                If you upload, publish, or share any content on the Platform
                (including but not limited to notes, courses, materials,
                articles, images, or videos), you agree to:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Ownership:</strong> Only upload content that you have
                  created yourself or for which you hold all necessary rights,
                  licences, and permissions to distribute
                </li>
                <li>
                  <strong>No Infringing Material:</strong> Do not upload any
                  content that infringes upon the copyrights, trademarks,
                  patents, trade secrets, or other intellectual property rights
                  of any third party
                </li>
                <li>
                  <strong>Appropriate Content:</strong> Do not upload content
                  that is offensive, defamatory, obscene, threatening, hateful,
                  or otherwise inappropriate or in violation of applicable law
                </li>
                <li>
                  <strong>Licence Grant:</strong> By uploading content, you
                  grant {COMPANY_INFO.name} a non-exclusive, worldwide,
                  royalty-free, sublicensable licence to use, reproduce,
                  display, distribute, and make available your content as
                  necessary to operate, promote, and improve the Platform.
                  This licence does not transfer ownership of your content to
                  us
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 5: Independent Contractor Relationship */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                5. Independent Contractor Relationship
              </h2>
              <p className="text-lg leading-relaxed">
                Consultants using the Platform are independent contractors, not
                employees, agents, or partners of {COMPANY_INFO.name}. The
                relationship between {COMPANY_INFO.name} and Consultants is
                strictly that of an independent marketplace operator and an
                independent service provider. The Platform does not:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Control how Consultants deliver their services, including the
                  methods, techniques, or curriculum used during sessions
                </li>
                <li>
                  Set Consultants&apos; working hours, schedules, or require
                  minimum availability on the Platform
                </li>
                <li>
                  Provide employment benefits, insurance, workers&apos;
                  compensation, retirement plans, or any other employee
                  protections
                </li>
                <li>
                  Require exclusivity &mdash; Consultants are free to offer
                  their services on other platforms or independently
                </li>
              </ul>
              <p className="text-lg leading-relaxed">
                Consultants are solely responsible for their own business
                expenses, equipment, professional licensing, certifications,
                insurance (if applicable), and compliance with all applicable
                laws and regulations in their jurisdiction.
              </p>
              <p className="text-lg leading-relaxed">
                For detailed terms governing the relationship between{" "}
                {COMPANY_INFO.name} and Consultants, please refer to our{" "}
                <a
                  href="/contractors"
                  className="text-blue-600 hover:underline"
                >
                  Contractor Agreement
                </a>
                .
              </p>

              <Separator className="my-8" />

              {/* Section 6: Payment Terms */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                6. Payment Terms
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.1 Pricing and Currency
              </h3>
              <p className="text-lg leading-relaxed">
                All prices on the Platform are displayed in Indian Rupees
                (INR). Consultants set their own pricing for sessions,
                consultations, classes, and subscription plans based on their
                expertise and market conditions. The platform charges a service
                fee on each transaction, as displayed at the time of booking.
                There are no hidden fees. The total amount shown during
                checkout is the final amount payable by the Student.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.2 Payment Processing
              </h3>
              <p className="text-lg leading-relaxed">
                All payments on the Platform are processed securely through
                our payment partner, Razorpay. We accept the following payment
                methods:
              </p>
              <ul className="text-lg space-y-2">
                <li>Credit cards (Visa, Mastercard, and others supported by Razorpay)</li>
                <li>Debit cards</li>
                <li>UPI (Unified Payments Interface)</li>
                <li>Net banking</li>
              </ul>
              <p className="text-lg leading-relaxed">
                By making a payment, you authorize {COMPANY_INFO.name} and
                Razorpay to charge the applicable amount to your selected
                payment method. Failed or declined payments may result in
                service interruption or cancellation of your booking. We do
                not store your complete payment credentials on our servers;
                all sensitive payment data is handled directly by Razorpay in
                compliance with PCI-DSS standards.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.3 Consultant Payouts
              </h3>
              <p className="text-lg leading-relaxed">
                Consultants receive payouts for their services after successful
                session completion and confirmation. The platform&apos;s
                service fee is deducted from the gross session amount before
                the payout is disbursed to the Consultant. Payouts are
                processed in accordance with the settlement schedule outlined
                in the{" "}
                <a
                  href="/contractors"
                  className="text-blue-600 hover:underline"
                >
                  Contractor Agreement
                </a>
                . {COMPANY_INFO.name} reserves the right to withhold payouts
                in cases of suspected fraud, policy violations, or pending
                dispute resolution.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.4 Tax Responsibilities
              </h3>
              <p className="text-lg leading-relaxed">
                Consultants are responsible for all applicable taxes including
                GST (if applicable based on turnover), income tax, and any
                other taxes required by law. The platform does not collect or
                remit taxes on behalf of Consultants. Consultants should
                consult their own tax advisors to understand their obligations
                and ensure compliance with all applicable tax regulations in
                their jurisdiction.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                6.5 Cancellations and Refunds
              </h3>
              <p className="text-lg leading-relaxed">
                Cancellations and refund eligibility are governed by our
                dedicated{" "}
                <a href="/refund" className="text-blue-600 hover:underline">
                  Cancellation &amp; Refund Policy
                </a>
                . By using the Platform, you agree to the terms outlined in
                that policy regarding cancellation windows, refund timelines,
                and non-refundable services. We encourage all users to review
                the Cancellation &amp; Refund Policy before making any bookings.
              </p>

              <Separator className="my-8" />

              {/* Section 7: Non-Circumvention */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                7. Non-Circumvention
              </h2>
              <p className="text-lg leading-relaxed">
                All transactions for services discovered through or facilitated
                by the Platform must be conducted through the Platform&apos;s
                payment system. Attempting to circumvent the Platform to avoid
                service fees, including soliciting or accepting off-platform
                payments, is a violation of these Terms and may result in
                account suspension or termination.
              </p>
              <p className="text-lg leading-relaxed">
                This non-circumvention obligation applies to both Consultants
                and Students. Specifically, you agree not to:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Share personal contact information (phone numbers, email
                  addresses, social media handles, or payment details) for the
                  purpose of conducting transactions outside the Platform
                </li>
                <li>
                  Use the Platform to identify or connect with Consultants or
                  Students and then complete the transaction off-platform
                </li>
                <li>
                  Encourage, request, or agree to any arrangement that bypasses
                  the Platform&apos;s payment processing to avoid service fees
                </li>
              </ul>
              <p className="text-lg leading-relaxed">
                Violations of this section may result in immediate account
                suspension or termination, forfeiture of pending payouts, and
                pursuit of any legal remedies available to{" "}
                {COMPANY_INFO.name}.
              </p>

              <Separator className="my-8" />

              {/* Section 8: Intellectual Property */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                8. Intellectual Property
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                8.1 Platform Intellectual Property
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform, including all software, code, design, text,
                graphics, logos, trademarks, service marks, user interfaces,
                visual elements, and other proprietary materials, are owned by
                or licensed to {COMPANY_INFO.name} and are protected by
                applicable intellectual property laws, including copyright,
                trademark, and trade secret laws. You may not copy, modify,
                reproduce, distribute, create derivative works from, publicly
                display, reverse engineer, or otherwise exploit any part of the
                Platform without our prior written consent.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                8.2 User-Generated Content
              </h3>
              <p className="text-lg leading-relaxed">
                You retain ownership of the content you submit, upload, or
                share on the Platform (including courses, notes, materials,
                reviews, and profile information). By submitting content, you
                grant {COMPANY_INFO.name} a non-exclusive, worldwide,
                royalty-free, transferable, sublicensable licence to use,
                reproduce, display, distribute, and make available your content
                as reasonably necessary to operate, promote, and improve the
                Platform. This licence terminates when you remove your content
                from the Platform or delete your account, except where your
                content has been shared with or relied upon by other users.
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                8.3 Course and Session Content
              </h3>
              <p className="text-lg leading-relaxed">
                Courses, session materials, presentations, recordings, and
                other educational content created by Consultants remain the
                intellectual property of their respective creators unless
                otherwise agreed in writing. Students may not reproduce,
                distribute, sell, share, or create derivative works from
                Consultant content without explicit written authorization from
                the content creator. Purchasing or attending a session grants
                you a personal, non-transferable right to access that content
                for your own private learning purposes only.
              </p>

              <Separator className="my-8" />

              {/* Section 9: Prohibited Activities */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                9. Prohibited Activities
              </h2>
              <p className="text-lg leading-relaxed">
                You agree not to engage in any of the following activities while
                using the Platform. Violation of these prohibitions may result
                in account suspension, termination, and/or legal action:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Illegal Use:</strong> Using the Platform for any
                  purpose that violates applicable local, state, national, or
                  international law or regulation
                </li>
                <li>
                  <strong>Harassment and Abuse:</strong> Harassing, bullying,
                  threatening, intimidating, or abusing other users,
                  Consultants, or staff, whether through messages, reviews,
                  sessions, or any other means
                </li>
                <li>
                  <strong>Fraud and Misrepresentation:</strong> Posting false,
                  misleading, or fraudulent information, including fake
                  reviews, fabricated credentials, or deceptive listings
                </li>
                <li>
                  <strong>Data Scraping:</strong> Using bots, crawlers,
                  scrapers, or any automated tools to collect, extract, or
                  harvest data from the Platform without our express written
                  permission
                </li>
                <li>
                  <strong>Unauthorized Access:</strong> Attempting to gain
                  unauthorized access to our systems, servers, networks,
                  databases, or other users&apos; accounts through hacking,
                  password mining, or any other method
                </li>
                <li>
                  <strong>Impersonation:</strong> Impersonating another person,
                  entity, or organization, or falsely representing your
                  affiliation with any person or entity
                </li>
                <li>
                  <strong>Off-Platform Solicitation:</strong> Soliciting users
                  to conduct transactions, communications, or engagements
                  outside the Platform for the purpose of circumventing
                  platform fees or policies
                </li>
                <li>
                  <strong>Service Disruption:</strong> Interfering with,
                  disrupting, or attempting to compromise the security,
                  integrity, or performance of the Platform or its underlying
                  infrastructure
                </li>
                <li>
                  <strong>Unauthorized Commercial Use:</strong> Using the
                  Platform for unauthorized advertising, spam, promotional
                  materials, or commercial solicitation without our prior
                  written consent
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 10: Disclaimers and Limitations of Liability */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                10. Disclaimers and Limitations of Liability
              </h2>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                10.1 Service Provided &quot;As Is&quot;
              </h3>
              <p className="text-lg leading-relaxed">
                The Platform and all content, services, and features available
                through it are provided on an &quot;as is&quot; and &quot;as
                available&quot; basis without warranties of any kind, whether
                express, implied, or statutory. To the fullest extent permitted
                by applicable law, {COMPANY_INFO.name} disclaims all
                warranties, including but not limited to implied warranties of
                merchantability, fitness for a particular purpose, and
                non-infringement. Without limiting the foregoing, we do not
                guarantee:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Any specific learning outcomes, academic results, career
                  advancement, or professional benefits from using the
                  Platform
                </li>
                <li>
                  The accuracy, completeness, reliability, or timeliness of
                  information provided by Consultants or other users
                </li>
                <li>
                  Uninterrupted, error-free, or secure access to the Platform
                  at all times
                </li>
                <li>
                  That any defects or errors in the Platform will be corrected
                  within any specific timeframe
                </li>
              </ul>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                10.2 Limitation of Liability
              </h3>
              <p className="text-lg leading-relaxed">
                To the maximum extent permitted by applicable law,{" "}
                {COMPANY_INFO.name}, its directors, officers, employees,
                affiliates, and agents shall not be liable for any indirect,
                incidental, special, consequential, exemplary, or punitive
                damages, including but not limited to loss of profits, data,
                goodwill, business opportunities, or other intangible losses,
                arising out of or in connection with your use of or inability
                to use the Platform.
              </p>
              <p className="text-lg leading-relaxed">
                In no event shall {COMPANY_INFO.name}&apos;s total aggregate
                liability to you for all claims arising out of or relating to
                these Terms or the Platform exceed the lower of: (a) the
                total amount of fees you have paid to {COMPANY_INFO.name} in
                the twelve (12) months immediately preceding the event giving
                rise to the claim, or (b) Rs. 10,000 (Indian Rupees Ten
                Thousand).
              </p>

              <h3 className="text-xl md:text-2xl font-semibold mt-6 mb-3">
                10.3 Third-Party and Consultant Disclaimers
              </h3>
              <p className="text-lg leading-relaxed">
                As a marketplace intermediary, {COMPANY_INFO.name} is not
                liable for:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  The performance, quality, accuracy, or appropriateness of
                  services provided by Consultants
                </li>
                <li>
                  Disputes, disagreements, or conflicts between Students and
                  Consultants, or between any users of the Platform
                </li>
                <li>
                  Failures, outages, or issues caused by third-party service
                  providers, including payment processors, hosting providers,
                  video conferencing tools, or internet service providers
                </li>
                <li>
                  Any advice, recommendations, or representations made by
                  Consultants during sessions or through the Platform
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 11: Indemnification */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                11. Indemnification
              </h2>
              <p className="text-lg leading-relaxed">
                You agree to indemnify, defend, and hold harmless{" "}
                {COMPANY_INFO.name}, its directors, officers, employees,
                affiliates, agents, and licensors from and against any and all
                claims, demands, actions, liabilities, damages, losses, costs,
                and expenses (including reasonable attorneys&apos; fees and
                legal costs) arising out of or in connection with:
              </p>
              <ul className="text-lg space-y-2">
                <li>Your violation of any provision of these Terms</li>
                <li>
                  Your use or misuse of the Platform, including any activity
                  conducted through your account
                </li>
                <li>
                  Any content you submit, upload, or share on the Platform
                </li>
                <li>
                  Your violation of any rights of a third party, including
                  intellectual property rights, privacy rights, or contractual
                  obligations
                </li>
                <li>
                  Any claim by a third party arising from your acts or
                  omissions in connection with the Platform
                </li>
              </ul>
              <p className="text-lg leading-relaxed">
                This indemnification obligation shall survive the termination
                of your account and these Terms.
              </p>

              <Separator className="my-8" />

              {/* Section 12: Dispute Resolution */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                12. Dispute Resolution
              </h2>
              <p className="text-lg leading-relaxed">
                Any dispute, controversy, or claim arising out of or relating
                to these Terms or the use of the Platform shall be resolved
                through the following process:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Informal Resolution:</strong> The parties shall first
                  attempt to resolve the dispute informally by contacting us
                  at{" "}
                  <a
                    href={getMailtoLink(COMPANY_INFO.supportEmail)}
                    className="text-blue-600 hover:underline"
                  >
                    {COMPANY_INFO.supportEmail}
                  </a>
                  . We will make good faith efforts to resolve your concern
                  within thirty (30) days of receiving your written notice of
                  the dispute
                </li>
                <li>
                  <strong>Mediation:</strong> If the dispute cannot be resolved
                  informally, the parties agree to attempt to settle it through
                  mediation administered by a mutually agreed-upon mediator
                  before resorting to litigation
                </li>
                <li>
                  <strong>Governing Law:</strong> These Terms and any disputes
                  arising hereunder shall be governed by and construed in
                  accordance with the laws of{" "}
                  {COMPANY_INFO.jurisdiction}, without regard to its conflict
                  of law principles
                </li>
                <li>
                  <strong>Jurisdiction:</strong> Subject to the informal
                  resolution and mediation requirements above, the courts of{" "}
                  {COMPANY_INFO.jurisdiction} shall have exclusive jurisdiction
                  over any legal proceedings arising out of or relating to
                  these Terms
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 13: Compliance with Indian Law */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                13. Compliance with Indian Law
              </h2>
              <p className="text-lg leading-relaxed">
                {COMPANY_INFO.name} operates in compliance with applicable
                Indian laws and regulations. The following legal frameworks
                apply to the operation of the Platform:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  <strong>Consumer Protection (E-Commerce) Rules, 2020:</strong>{" "}
                  As a marketplace e-commerce entity, {COMPANY_INFO.name}{" "}
                  fulfils its obligations under the Consumer Protection
                  (E-Commerce) Rules, 2020, including displaying accurate
                  information about Consultants and services, providing a
                  grievance redressal mechanism, and ensuring fair treatment of
                  consumers. We do not exercise ownership or control over the
                  services offered by Consultants on the Platform
                </li>
                <li>
                  <strong>Information Technology Act, 2000:</strong> The
                  Platform operates as an intermediary under the Information
                  Technology Act, 2000, and complies with the Information
                  Technology (Intermediary Guidelines and Digital Media Ethics
                  Code) Rules, 2021. We maintain the necessary due diligence
                  standards, content moderation procedures, and grievance
                  officer designations as required under these provisions
                </li>
                <li>
                  <strong>Consumer Protection Act, 2019:</strong> Students
                  using the Platform are entitled to the protections afforded
                  by the Consumer Protection Act, 2019, including the right to
                  file complaints with the appropriate consumer forum. Nothing
                  in these Terms shall be construed to limit or restrict any
                  statutory consumer rights
                </li>
              </ul>

              <Separator className="my-8" />

              {/* Section 14: Privacy */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                14. Privacy
              </h2>
              <p className="text-lg leading-relaxed">
                Your use of the Platform is also governed by our{" "}
                <a href="/privacy" className="text-blue-600 hover:underline">
                  Privacy Policy
                </a>
                , which describes in detail how we collect, use, store, share,
                and protect your personal information. By using the Platform,
                you consent to the practices described in the Privacy Policy.
                We encourage you to review the Privacy Policy carefully and
                contact us if you have any questions about how your data is
                handled.
              </p>

              <Separator className="my-8" />

              {/* Section 15: Changes to Terms */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                15. Changes to Terms
              </h2>
              <p className="text-lg leading-relaxed">
                {COMPANY_INFO.name} reserves the right to modify, amend, or
                update these Terms at any time at our sole discretion. When we
                make material changes, we will:
              </p>
              <ul className="text-lg space-y-2">
                <li>
                  Post the revised Terms on this page with an updated
                  &quot;Last Updated&quot; date
                </li>
                <li>
                  Send a notification to registered users via email or through
                  in-platform notifications to inform them of the changes
                </li>
              </ul>
              <p className="text-lg leading-relaxed">
                Your continued use of the Platform after the revised Terms
                have been posted constitutes your acceptance of the updated
                Terms. If you do not agree with the changes, you must
                discontinue use of the Platform and may request account
                deletion.
              </p>

              <Separator className="my-8" />

              {/* Section 16: Severability */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                16. Severability
              </h2>
              <p className="text-lg leading-relaxed">
                If any provision or part of a provision of these Terms is found
                to be invalid, illegal, or unenforceable by a court of
                competent jurisdiction, such finding shall not affect the
                validity and enforceability of the remaining provisions, which
                shall continue in full force and effect. The invalid or
                unenforceable provision shall be deemed modified to the minimum
                extent necessary to make it valid and enforceable while
                preserving the parties&apos; original intent.
              </p>

              <Separator className="my-8" />

              {/* Section 17: Entire Agreement */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                17. Entire Agreement
              </h2>
              <p className="text-lg leading-relaxed">
                These Terms, together with our{" "}
                <a href="/privacy" className="text-blue-600 hover:underline">
                  Privacy Policy
                </a>
                ,{" "}
                <a href="/refund" className="text-blue-600 hover:underline">
                  Cancellation &amp; Refund Policy
                </a>
                , and{" "}
                <a
                  href="/contractors"
                  className="text-blue-600 hover:underline"
                >
                  Contractor Agreement
                </a>{" "}
                (for Consultants), constitute the entire agreement between you
                and {COMPANY_INFO.name} regarding your use of the Platform.
                These documents supersede all prior and contemporaneous
                understandings, agreements, representations, and warranties,
                whether written or oral, regarding the subject matter herein.
                No waiver of any provision of these Terms shall be deemed a
                further or continuing waiver of such provision or any other
                provision.
              </p>

              <Separator className="my-8" />

              {/* Section 18: Contact Us */}
              <h2 className="text-2xl md:text-3xl font-semibold mt-8 mb-5">
                18. Contact Us
              </h2>
              <p className="text-lg leading-relaxed">
                If you have any questions, concerns, or feedback regarding
                these Terms &amp; Conditions, please reach out to us through
                any of the following channels:
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
                  <strong>Support Email:</strong>{" "}
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

              {/* Acceptance of Terms Callout */}
              <div className="bg-yellow-50 dark:bg-yellow-950 p-8 rounded-lg mt-10">
                <h3 className="text-xl font-semibold mb-3">
                  Acceptance of Terms
                </h3>
                <p className="text-base leading-relaxed">
                  By using Familiarise, you acknowledge that you have read,
                  understood, and agree to be bound by these Terms &amp;
                  Conditions, along with our{" "}
                  <a
                    href="/privacy"
                    className="text-blue-600 hover:underline"
                  >
                    Privacy Policy
                  </a>
                  ,{" "}
                  <a
                    href="/refund"
                    className="text-blue-600 hover:underline"
                  >
                    Cancellation &amp; Refund Policy
                  </a>
                  , and{" "}
                  <a
                    href="/contractors"
                    className="text-blue-600 hover:underline"
                  >
                    Contractor Agreement
                  </a>{" "}
                  (if applicable). If you are using the Platform on behalf of
                  an organization, you represent and warrant that you have the
                  authority to bind that organization to these Terms.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
