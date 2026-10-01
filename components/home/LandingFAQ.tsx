import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  LandingContainer,
  LandingTextLink,
  SectionIntro,
} from "./LandingShared";

const QUESTIONS = [
  {
    question: "How do I find the right expert?",
    answer:
      "Start with your field or the question you want help with. Compare profiles, experience, reviews, and offerings, then read the full plan details to see what fits your goals.",
  },
  {
    question: "What’s the difference between a consultation and mentorship?",
    answer:
      "A consultation is a focused one-to-one session. Mentorship offers guidance over a longer period, following the expert’s selected plan. Classes follow a structured curriculum, while webinars bring people together for a live group session.",
  },
  {
    question: "Can I review the curriculum before booking?",
    answer:
      "Yes. Plan details show the curriculum and outcomes the expert has published. When a curriculum brochure is offered, you can also download it for offline review. Check the full page for the current offering details.",
  },
  {
    question: "When do I choose my session time?",
    answer:
      "For consultations, you choose from the times shown during booking. Mentorship session dates are arranged with your expert after purchase. Classes and webinars show their session dates on the program page. Booking confirms the current availability.",
  },
] as const;

export function LandingFAQ() {
  return (
    <section className="bg-white py-16 sm:py-20 lg:py-24">
      <LandingContainer className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div>
          <SectionIntro
            eyebrow="A little more clarity"
            title="Before you take the next step."
          />
          <LandingTextLink href="/support" className="mt-5">
            Visit the help centre
          </LandingTextLink>
        </div>
        <Accordion type="single" collapsible className="w-full min-w-0">
          {QUESTIONS.map((item, index) => (
            <AccordionItem
              key={item.question}
              value={`landing-faq-${index}`}
              className="border-zinc-200"
            >
              <AccordionTrigger className="gap-4 py-5 text-left text-sm font-medium leading-relaxed text-zinc-900 hover:no-underline [&>svg]:text-zinc-500">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="pb-5 text-sm leading-relaxed text-zinc-600">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
          <AccordionItem
            value="landing-faq-payments"
            className="border-zinc-200"
          >
            <AccordionTrigger className="gap-4 py-5 text-left text-sm font-medium leading-relaxed text-zinc-900 hover:no-underline [&>svg]:text-zinc-500">
              What should I know about payments and cancellations?
            </AccordionTrigger>
            <AccordionContent className="pb-5 text-sm leading-relaxed text-zinc-600">
              Review the price and booking terms before paying. Cancellation and
              refund terms depend on the offering and are shown during booking.
              You can also read our{" "}
              <Link
                href="/refund"
                className="font-medium text-zinc-900 underline underline-offset-4"
              >
                refund policy
              </Link>
              .
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </LandingContainer>
    </section>
  );
}
