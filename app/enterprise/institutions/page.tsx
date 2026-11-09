import type { Metadata } from "next";

import EnterprisePageLayout from "../_components/EnterprisePageLayout";
import { enterpriseClosing, enterpriseHero } from "../_components/page-data";
import {
  EnterpriseFaqs,
  EnterpriseVerticalTimeline,
} from "../_components/EnterpriseSections";

export const metadata: Metadata = {
  title: "For colleges and institutions | Familiarise for business",
  description:
    "Give a batch of students funded access to vetted industry experts for career guidance, interview preparation and mentorship, with one sponsor organisation behind it.",
};

const FAQS = [
  {
    question: "Can a college sponsor sessions for its students?",
    answer:
      "Yes. The institution is the sponsor organisation, students are its members, and covered bookings are paid by the program instead of the student.",
  },
  {
    question: "How do we confirm who is a student?",
    answer:
      "Your organisation verifies its email domain, and members join by invitation from an owner or manager. Only invited members are covered.",
  },
  {
    question: "Can students choose their own expert?",
    answer:
      "By default they can book across the marketplace. If a placement cell wants a shortlist, a consultant allowlist can be set on the program.",
  },
  {
    question: "Can our faculty or alumni be the experts?",
    answer:
      "Yes. An institution can also list its own experts and plans in the partner organisations directory.",
  },
];

export default function EnterpriseInstitutionsPage() {
  return (
    <EnterprisePageLayout
      hero={enterpriseHero({
        eyebrow: "For business · Institutions",
        titleLead: "Put industry experts in front of",
        titleAccent: "every student batch.",
        subtitle:
          "Fund career guidance, mock interviews and mentorship for a cohort of students, and let them book vetted experts without paying out of pocket.",
        secondaryCta: {
          label: "How funding works",
          href: "/enterprise/funding",
        },
        assurances: [
          "Invited student members",
          "Seats for a batch",
          "Optional expert shortlist",
        ],
        card: {
          title: "A typical placement-season setup",
          items: [
            "Verify the institution's email domain.",
            "Invite the batch and assign them to a seat program.",
            "Students book interview prep and career sessions; the program pays.",
            "Finance settles by wallet or invoice against the agreement.",
          ],
          footnote: "Batch size and covered sessions are agreed in onboarding.",
        },
        demoHref: "/enterprise/demo?useCase=institution",
      })}
      faqsJsonLd={FAQS}
      closing={enterpriseClosing({
        title: "Planning the next placement season?",
        description:
          "Tell us the batch size and the kind of guidance students need. We will propose a program and walk the placement team through it.",
        secondaryCta: {
          label: "What students get",
          href: "/use-cases/college-students",
        },
        demoHref: "/enterprise/demo?useCase=institution",
      })}
    >
      <EnterpriseVerticalTimeline
        eyebrow="Setup"
        title="From agreement to the first booking"
        intro="Four steps, handled with our team."
        steps={[
          {
            label: "Step 1",
            title: "Agree the program",
            description:
              "Batch size, covered session types and the funding source, wallet or invoice.",
          },
          {
            label: "Step 2",
            title: "Verify the institution",
            description:
              "Confirm the email domain and billing details so members can be covered.",
          },
          {
            label: "Step 3",
            title: "Invite the batch",
            description:
              "Owners and managers invite students and attach them to the program.",
          },
          {
            label: "Step 4",
            title: "Students book",
            description:
              "Covered bookings are paid by the program, and the institution sees utilisation.",
          },
        ]}
      />

      <EnterpriseFaqs
        eyebrow="Questions"
        title="Institution FAQs"
        intro="What placement cells and deans ask first."
        items={FAQS}
      />
    </EnterprisePageLayout>
  );
}
