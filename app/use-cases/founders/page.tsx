import type { Metadata } from "next";

import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

export const metadata: Metadata = {
  title: "Startup Idea Validation for Founders in India | Familiarise",
  description:
    "Test whether people will pay, whether you're the right founder for it, and whether the timing is right — before you quit your job. Talk to someone who has actually built, sold, or shut down a startup.",
};

/**
 * Segment thesis: this reader is not short of encouragement — friends and
 * LinkedIn will supply infinite enthusiasm for free. What is scarce is someone
 * who will actually try to kill the idea before they quit a job for it. So the
 * spine is a matrix of three independent stress tests rather than a single
 * roadmap: commercial demand, founder-market fit, and timing are separate
 * questions, and an idea can pass two of the three and still be wrong.
 *
 * Framing sources:
 * - Paul Graham, "How to Get Startup Ideas" (2012) — the idea itself is
 *   rarely the constraint; testing it against a real problem is:
 *   http://paulgraham.com/startupideas.html
 * - CB Insights, "Why Startups Fail" — recurring postmortem research citing
 *   weak product-market fit and bad timing among the leading causes, well
 *   ahead of "the idea itself was bad":
 *   https://www.cbinsights.com/research/report/startup-failure-reasons-top/
 * - Bill Gross, "The Single Biggest Reason Why Startups Succeed", TED (2015)
 *   — analysing over 200 companies at Idealab and outside it, timing
 *   accounted for the largest share (42%) of the difference between success
 *   and failure, ahead of team, idea, business model and funding:
 *   https://www.ted.com/talks/bill_gross_the_single_biggest_reason_why_start_ups_succeed
 */
const data: UseCasePageData = {
  hero: {
    eyebrow: "For first-time founders",
    titleLead: "The idea is the easy part.",
    titleAccent: "Proving it deserves your time is not.",
    subtitle:
      "Friends will tell you they love it. Money is the only vote that counts, and almost nobody in your life will cast it honestly. Talk to someone who has actually built, sold, or killed something like this before you quit your job for it.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See startup-experienced experts",
      href: "/explore/experts?search=Startups",
    },
    assurances: [
      "No pitch deck required for the first call",
      "Cancel 24 hours ahead for a full refund",
      "Pay in ₹ by UPI, card or net banking",
    ],
    card: {
      title: "What the first call should settle",
      items: [
        "Whether anyone would actually pay for this, or people are just being encouraging.",
        "What you're calling an unfair advantage, and whether it would survive someone else trying the same thing.",
        "Whether this is early, on time, or a race you've already lost to someone better funded.",
        "The smallest, cheapest test that would actually change your mind about doing this.",
      ],
      footnote:
        "Consultations start at 30 minutes, and the expert's price is on their profile before you book anything.",
    },
  },

  pains: {
    eyebrow: "Why most ideas don't survive contact",
    title: "None of this is about how hard you're willing to work",
    intro:
      "The failure modes here are well documented, and almost none of them are about effort or intelligence. They are about which question got skipped.",
    items: [
      {
        title: "Enthusiasm is the cheapest signal that exists",
        description:
          "Everyone you show it to has a reason to be encouraging: they like you, they don't want to be the one who crushed it, or they enjoy the idea of you trying. None of that is evidence anyone would pay for it. The only signal that means anything is money changing hands, or a firm commitment to hand it over.",
      },
      {
        title: "You are comparing the idea to nothing",
        description:
          "\"Nobody else is doing this\" usually means people already solve the problem some other way — a spreadsheet, a person they call, doing without. Naming that real alternative, and what people currently spend on it, tells you far more than naming the competitors who share your exact pitch.",
      },
      {
        title: "Familiarity with a market is not an edge inside it",
        description:
          "Having worked in an industry, or simply caring about a problem, feels like an advantage from the inside. It rarely survives the question of who else could build this — with better distribution, more capital, or a head start you don't have.",
      },
      {
        title: "The idea can be right and the moment can still be wrong",
        description:
          "A good idea launched before the market is ready, or after someone better resourced has already claimed it, fails for reasons that have nothing to do with execution. Timing is not a footnote to the pitch — on the evidence, it is closer to the headline.",
      },
    ],
    footnote:
      "Analysing more than 200 companies inside and outside his own incubator, Bill Gross found timing accounted for the largest share of the difference between the startups that succeeded and the ones that didn't — 42%, ahead of team, idea, business model and funding combined. It is the strongest argument for stress-testing timing on purpose rather than assuming it will take care of itself.",
  },

  spine: {
    variant: "matrix",
    eyebrow: "Run all three before you quit anything",
    title: "Three separate questions. Passing two is not passing.",
    intro:
      "Each of these can be tested in a single conversation, and each one kills a different kind of bad idea. One that survives all three is worth your time. One that survives only one or two is not yet.",
    items: [
      {
        icon: "wallet",
        label: "Test one — Demand",
        title: "Will anyone actually pay, or just say they like it?",
        description:
          "The gap between what people say they want and what they spend money on is where most ideas quietly die. What matters is the closest thing people already pay for, what they spend on it today, and the specific trigger that would make someone pay for yours instead — not the applause.",
      },
      {
        icon: "userCheck",
        label: "Test two — Founder fit",
        title: "Are you positioned to win this, or just excited about it?",
        description:
          "An unfair advantage is something real — distribution you already have, a network that opens doors, expertise a competitor would need years to match. Familiarity with the space, or simply wanting it badly, is not on that list. If somebody else is plainly better placed to build it, that is worth hearing before you start, not after.",
      },
      {
        icon: "trending",
        label: "Test three — Timing",
        title: "Is now actually the moment, or just your moment?",
        description:
          "Something has to have changed recently to make this newly possible — a cost that dropped, a behaviour that shifted, a platform that opened up. If nothing has changed, ask why it hasn't been done already. And work out honestly what would still be yours if a better-funded team shipped the same idea next month.",
      },
    ],
    footnote:
      "If your idea only just passed one of these, that is useful information, not a verdict — the point of running all three is finding out which one to fix first.",
  },

  sessions: {
    eyebrow: "What you book",
    title: "A verdict, not a pep talk",
    intro:
      "Each of these is a single booking with someone who has actually built, sold, or shut down something — not a workshop, and not a course.",
    items: [
      {
        icon: "search",
        title: "An idea stress-test",
        description:
          "Bring the idea exactly as it stands today, including the parts you're unsure about. You leave with a plain verdict on whether it looks like a business or an interesting idea, and why.",
      },
      {
        icon: "wallet",
        title: "Pricing and packaging review",
        description:
          "For an idea that already has a rough shape: what to charge, how to package it, and whether the model you've picked actually fits how the money would really move.",
      },
      {
        icon: "users",
        title: "Co-founder and early-hire conversations",
        description:
          "Whether you need a co-founder at all, what to actually test for in one, and how to have the equity conversation before it becomes an argument.",
      },
      {
        icon: "chart",
        title: "Fundraising timing",
        description:
          "Whether to raise now, bootstrap longer, or wait for a specific milestone — from someone who has sat on one side of that table or the other.",
      },
    ],
  },

  checklist: {
    eyebrow: "Before you quit anything",
    title: "Run this before you hand in your notice",
    intro:
      "The costliest startup mistakes are rarely the product decisions. They are the commitments made a week before anyone stress-tested the idea.",
    items: [
      {
        title: "Separate enthusiasm from evidence, in writing",
        description:
          "List who has actually paid, committed to pay, or given you a specific number they'd pay — not who said it sounded interesting. If that list is empty, that is the finding, not a formality.",
      },
      {
        title: "Name the smallest test that would change your mind",
        description:
          "Decide, before you build anything, what result would make you stop. If no result would, you are not testing the idea — you are looking for permission to keep going.",
      },
      {
        title: "Get a real runway number and a real stop date",
        description:
          "Not a vague sense of savings — a number of months, and a specific date on which you revisit the decision regardless of how optimistic that particular week feels.",
      },
      {
        title: "Have the \"someone better funded ships this\" conversation",
        description:
          "Decide, honestly, what would still be yours if a well-capitalised team launched the same idea next month. If the answer is nothing, that is worth knowing now rather than a year in.",
      },
      {
        title: "Ask someone with no reason to be kind to you",
        description:
          "Not a friend, not a family member, not someone who mainly wants to see you happy. Someone whose job has involved making exactly this call about other people's ideas.",
      },
    ],
    footnote:
      "None of this is a reason not to start. It is a much cheaper way to find out you shouldn't than building it first.",
  },

  comparison: {
    eyebrow: "The honest comparison",
    title: "Three ways to find out if the idea is real",
    intro:
      "All three can work. They differ in how long they take, what they actually test, and how much it costs you to get a wrong answer.",
    alternatives: [
      "Asking friends, family and LinkedIn",
      "Applying to an accelerator or incubator",
    ],
    ourLabel: "A session with a founder here",
    rows: [
      {
        criterion: "What it actually tests",
        alternatives: [
          "Whether people like you enough to be encouraging.",
          "Whether a partner is persuaded by a ten-minute pitch.",
        ],
        ours: "Whether the commercial logic holds up to someone who has actually operated in your market.",
      },
      {
        criterion: "Turnaround",
        alternatives: [
          "Instant.",
          "Weeks to months, on their application cycle.",
        ],
        ours: "Booked on your own schedule, usually within the week.",
      },
      {
        criterion: "Cost of a wrong answer",
        alternatives: [
          "Nothing — which is exactly the problem.",
          "Weeks on an application, then a rejection with no real reason given.",
        ],
        ours: "One session's fee, spent before you've built anything or resigned from anything.",
      },
      {
        criterion: "Who is answering",
        alternatives: [
          "People with every incentive to be kind and no exposure to your market.",
          "A partner who reads hundreds of decks a year and will not remember yours by lunch.",
        ],
        ours: "Someone you chose because of what they've actually built, sold or shut down.",
      },
      {
        criterion: "What you give up",
        alternatives: [
          "Nothing, and you get nothing reliable back.",
          "Often equity, and months of your timeline.",
        ],
        ours: "The expert's listed price, visible before you book. Nothing else.",
      },
    ],
    footnote:
      "If the idea is genuinely strong, apply to the accelerator too — this is the conversation worth having before that application, not instead of it.",
  },

  categories: {
    eyebrow: "Where to start",
    title: "Find someone who has actually done this",
    intro:
      "Every listing shows the expert's price and session length, and reviews left only by people who completed a real session.",
    links: [
      { label: "Startups", href: "/explore/experts?search=Startups" },
      { label: "Business", href: "/explore/experts?search=Business" },
      { label: "Marketing", href: "/explore/experts?search=Marketing" },
      { label: "Technology", href: "/explore/experts?search=Technology" },
      { label: "Design", href: "/explore/experts?search=Design" },
      {
        label: "Personal development",
        href: "/explore/experts?search=Personal+Development",
      },
    ],
  },

  faqs: {
    eyebrow: "Before you book",
    title: "What founders ask us first",
    intro: "Direct answers, none of which require a sales call.",
    items: [
      {
        question: "I don't have a product yet. Is there anything to even talk about?",
        answer:
          "That is the ideal time, not too early. The point of a stress-test session is to happen before you've built anything — it is the cheapest moment to find out something is wrong.",
      },
      {
        question: "What if the verdict is that I shouldn't do this?",
        answer:
          "Then that is what you are paying for. Nobody here has a course or a cohort to sell you afterwards, so there is no incentive to tell you what you want to hear.",
      },
      {
        question: "Do I need an NDA before I share my idea?",
        answer:
          "Generally no — ideas are rarely the scarce part of a startup, and asking a stranger to sign one before a single call tends to slow things down more than it protects you. If your situation genuinely needs one, mention it when you book so the expert can decide before accepting.",
      },
      {
        question: "How is this different from a pitch competition or an accelerator interview?",
        answer:
          "Those are auditions — you are being judged for a prize or a spot. This is a working session, bought and paid for, whose only goal is giving you a straight answer. Nothing is being awarded, so there is nothing to perform for.",
      },
      {
        question: "I'm not incorporated yet. Can I still book?",
        answer:
          "Yes. Most people booking this are pre-incorporation, sometimes pre-everything beyond a document and a conviction. That is exactly the stage this is built for.",
      },
      {
        question: "What if my idea only fails one of the three tests?",
        answer:
          "Then you've found the one thing worth fixing before the other two matter. Very few ideas pass all three the first time, and that is normal rather than fatal.",
      },
      {
        question: "What if the session turns out to be unhelpful?",
        answer:
          "Cancel at least 24 hours ahead and you're refunded in full. If the expert cancels, you're refunded in full regardless of when that happens.",
      },
    ],
  },

  closing: {
    title: "Find out before you've spent a year on it",
    description:
      "One conversation with someone who has actually built, sold, or shut down something like this — including, if that's where the evidence points, the conversation where they tell you not to.",
    primaryCta: { label: "Find an expert", href: "/explore/experts" },
    secondaryCta: {
      label: "See startup-experienced experts",
      href: "/explore/experts?search=Startups",
    },
    reassurance:
      "No pitch deck required. Cancel 24 hours ahead for a full refund.",
  },

  order: [
    "pains",
    "spine",
    "sessions",
    "checklist",
    "comparison",
    "categories",
    "faqs",
  ],
};

export default function FoundersPage() {
  return <UseCasePageLayout data={data} />;
}
