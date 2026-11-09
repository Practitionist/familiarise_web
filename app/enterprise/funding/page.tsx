import type { Metadata } from "next";

import EnterprisePageLayout from "../_components/EnterprisePageLayout";
import { enterpriseClosing, enterpriseHero } from "../_components/page-data";
import {
  EnterpriseAlternatingRows,
  EnterpriseComparison,
  EnterpriseFaqs,
} from "../_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "How funding works | Familiarise for business",
  description:
    "Seats or a shared credit pool, paid by wallet, monthly invoice or licence: how an organisation funds expert sessions on Familiarise, and what happens when usage goes over.",
};

const FAQS = [
  {
    question: "Who pays when a learner books?",
    answer:
      "The funding source you choose for the program: your prepaid wallet, your monthly invoice, or a prepaid licence. The learner sees a covered booking instead of a card payment. A program can also leave the learner paying personally while the organisation tracks the spend.",
  },
  {
    question: "What happens when a program runs over its allowance?",
    answer:
      "You choose per program. Block further bookings, charge the overage to the organisation (with an optional surcharge, plus GST), or have the learner pay the overage themselves.",
  },
  {
    question: "Can we require a purchase order?",
    answer:
      "Yes. When a purchase order is required, bookings against that account stop until a valid one is on file, so spend cannot run ahead of procurement.",
  },
  {
    question: "Do we get GST invoices?",
    answer:
      "Yes. Organisation billing produces GST-compliant invoices. E-invoice (IRN) generation is handled case by case, so tell us if your finance team needs it.",
  },
  {
    question: "Is there a price list?",
    answer:
      "Not yet. Commercial terms are agreed with our team, based on headcount, domains and how you want to fund the program. Book a demo and we will scope it with you.",
  },
];

export default function EnterpriseFundingPage() {
  return (
    <EnterprisePageLayout
      hero={enterpriseHero({
        eyebrow: "For business · Funding",
        titleLead: "Decide who pays,",
        titleAccent: "and how far it goes.",
        subtitle:
          "Pick how a program is shared (seats or a credit pool), how it is paid (wallet, invoice or licence) and what happens when usage goes over.",
        secondaryCta: {
          label: "All business options",
          href: "/enterprise",
        },
        assurances: [
          "Seats or shared credits",
          "Wallet, invoice or licence",
          "You set the overage rule",
        ],
        card: {
          title: "Three choices per program",
          items: [
            "How it is shared: licensed seats for a cohort, or a credit pool people draw from.",
            "How it is paid: prepaid wallet, monthly invoice, or a prepaid licence.",
            "What happens at the limit: block, bill the organisation, or bill the learner.",
          ],
          footnote:
            "Commercial terms are agreed with our team during onboarding.",
        },
      })}
      faqsJsonLd={FAQS}
      closing={enterpriseClosing({
        title: "Not sure which combination fits?",
        description:
          "Tell us your headcount, who should be able to book, and how finance wants to settle. We will propose a setup and walk you through it.",
        secondaryCta: {
          label: "See team training",
          href: "/enterprise/team-training",
        },
      })}
    >
      <EnterpriseComparison
        eyebrow="How it is shared"
        title="Seats or a credit pool"
        intro="The two ways a program spreads its budget across people."
        left={{
          label: "Seats",
          title: "Licensed seats",
          points: [
            "A fixed number of seats for a cohort",
            "Every assigned learner has the same access",
            "Predictable for finance",
            "Suits graduate batches and new-manager ramps",
          ],
          href: "/enterprise/team-training",
          ctaLabel: "See team training",
        }}
        right={{
          label: "Credits",
          title: "Credit pool",
          points: [
            "One shared budget drawn down per booking",
            "Usage can vary widely by role",
            "People choose experts as the need appears",
            "Suits mentorship where few people book often",
          ],
          href: "/enterprise/corporate-mentorship",
          ctaLabel: "See corporate mentorship",
        }}
      />

      <EnterpriseAlternatingRows
        eyebrow="How it is paid"
        title="Four ways to fund a booking"
        intro="Each program points at one of these. Different programs in the same organisation can use different ones."
        rows={[
          {
            icon: "wallet",
            title: "Prepaid wallet",
            description:
              "Top up once. Each covered booking debits the wallet at the moment it is made, so the balance always shows what is left.",
          },
          {
            icon: "fileCheck",
            title: "Monthly invoice",
            description:
              "Bookings accrue through the month and roll up into one invoice, with a purchase order if your procurement needs one.",
          },
          {
            icon: "briefcase",
            title: "Prepaid licence",
            description:
              "A contract paid up front. Covered bookings cost the learner nothing and draw nothing further.",
          },
          {
            icon: "users",
            title: "Learner pays, organisation tracks",
            description:
              "People pay by card as they do today while the organisation tags the bookings and tracks spend against an allowance.",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Funding FAQs"
        intro="The questions finance and L&D teams ask first."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
