import type { Metadata } from "next";

import EnterprisePageLayout from "../_components/EnterprisePageLayout";
import { enterpriseClosing, enterpriseHero } from "../_components/page-data";
import {
  EnterpriseAlternatingRows,
  EnterpriseFaqs,
} from "../_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "Security and compliance | Familiarise for business",
  description:
    "How Familiarise handles organisation access, sign-in, consent, billing records and recordings, for Indian organisations on INR.",
};

const FAQS = [
  {
    question: "Do you support single sign-on?",
    answer:
      "Yes. An organisation can set up SSO for its members. The setup steps are in our help centre, and our team helps with the first connection.",
  },
  {
    question: "How long are session recordings kept?",
    answer:
      "Recordings are included with a booking and kept for 90 days for one-to-one and mentorship sessions, and 365 days for webinars and classes, then deleted. Hosts record only after a consent step.",
  },
  {
    question: "How do you handle personal data requests?",
    answer:
      "Members can withdraw consent and request deletion of their data from their account, and our grievance process is published. Deletion is subject to the records we must keep for tax and payments.",
  },
  {
    question: "Can we send a security questionnaire?",
    answer:
      "Yes. Send it with your demo request and our team will respond. We do not currently publish third-party security certifications on this page.",
  },
];

export default function EnterpriseSecurityPage() {
  return (
    <EnterprisePageLayout
      hero={enterpriseHero({
        eyebrow: "For business · Security",
        titleLead: "Control who gets in,",
        titleAccent: "and what is kept.",
        subtitle:
          "Organisation access by invitation and role, consent before recording, and billing records finance can audit.",
        secondaryCta: {
          label: "How funding works",
          href: "/enterprise/funding",
        },
        assurances: [
          "Invitation-based membership",
          "Consent before recording",
          "GST-compliant invoices",
        ],
        card: {
          title: "What your security team can check",
          items: [
            "Verified organisation email domain and billing consent.",
            "Roles for owners, managers, learners and experts.",
            "Recording retention windows by session type.",
            "Published terms, privacy policy and grievance process.",
          ],
          footnote: "Ask for anything else in the demo or your questionnaire.",
        },
      })}
      faqsJsonLd={FAQS}
      closing={enterpriseClosing({
        title: "Running a security review?",
        description:
          "Send your questionnaire with a demo request and we will answer it.",
        secondaryCta: { label: "Read the privacy policy", href: "/privacy" },
      })}
    >
      <EnterpriseAlternatingRows
        eyebrow="What we do"
        title="Access, consent and records"
        intro="Each of these is how the product works today."
        rows={[
          {
            icon: "shield",
            title: "Access by invitation and role",
            description:
              "Members join an organisation by invitation. Owners, managers, learners and experts each see only what their role allows, and organisation actions are recorded in an audit log.",
          },
          {
            icon: "building",
            title: "Verified domain and billing consent",
            description:
              "Funding turns on only after the organisation's email domain is verified and its billing consent is given.",
          },
          {
            icon: "users",
            title: "Single sign-on",
            description: "Organisations can connect SSO for their members.",
          },
          {
            icon: "fileCheck",
            title: "Records finance can audit",
            description:
              "GST-compliant invoices, purchase-order checks and a ledger behind every payment.",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Security FAQs"
        intro="What IT and procurement teams ask first."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
