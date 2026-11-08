import type { Metadata } from "next";
import Link from "next/link";
import { Calendar, IndianRupee, Repeat, Users, Video } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  PAYOUT_CONSTANTS,
  TAX_CONSTANTS,
} from "@/lib/payments/payouts/constants";
import { formatCurrencyAmount } from "@/utils/formatting";
import { buyerDisplayPricePaise } from "@/lib/payments/pricing/display-price";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";
import {
  PAGE_META,
  PRICING_DATA,
  pricingFaqs,
  pricingHowItWorks,
} from "../constants";

// The GST wording follows PLATFORM_GSTIN; hourly regeneration picks up a registration.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: `${PAGE_META.pricing.title} | Familiarise`,
  description: PAGE_META.pricing.description,
};

const EXAMPLE_LIST_PRICE_PAISE = 100_000;
const exampleFeePaise = Math.round(
  (EXAMPLE_LIST_PRICE_PAISE * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
);

function inr(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

const SERVICES = [
  {
    icon: Users,
    title: "Tutoring & One-on-One Sessions",
    badge: "Per Session",
    description:
      "Personal sessions with an expert on a subject or skill, tailored to your goals.",
    pricing:
      "Set by each expert per session, and shown in INR on their profile and booking page.",
  },
  {
    icon: Calendar,
    title: "Live Classes",
    badge: "Per Course",
    description:
      "Group classes taught live by an instructor across scheduled sessions, with course materials and, where the expert offers one, a certificate.",
    pricing:
      "Set by the expert for the whole class and shown before you enroll. Payment for the class is taken at enrollment.",
  },
  {
    icon: Video,
    title: "Webinars & Workshops",
    badge: "Per Event",
    description:
      "Live educational events and workshops on a specific topic, with Q&A.",
    pricing: "Set by the event host and shown before you register.",
  },
  {
    icon: Repeat,
    title: "Subscription Plans",
    badge: "Recurring",
    description:
      "Ongoing programs with regular live sessions over a set period.",
    pricing:
      "Set by the expert based on how often you meet and for how long, and shown before you subscribe.",
  },
] as const;

export default function PricingPage() {
  const gstRegistered = isPlatformGstRegistered();
  const totalPaise = buyerDisplayPricePaise(
    EXAMPLE_LIST_PRICE_PAISE,
    gstRegistered,
  );
  const exampleGstPaise = totalPaise - EXAMPLE_LIST_PRICE_PAISE;
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.pricing.title}
          </h1>
          <p className="text-fluid-lg text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.pricing.description}
          </p>
        </div>

        <div className="max-w-4xl mx-auto space-y-8">
          {/* Pricing Model Overview */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <IndianRupee className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">
                  How Our Pricing Works
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Familiarise is a marketplace for live learning. Each expert sets
                the price of what they teach, so there is no single price list.
                What stays the same for everyone is how the price is built up:
              </p>
              <div className="bg-muted p-4 rounded-lg space-y-2">
                {pricingHowItWorks(gstRegistered).map((item) => (
                  <p key={item} className="flex items-start gap-2">
                    <span className="text-green-600 mt-1">✓</span>
                    <span>{item}</span>
                  </p>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Worked example */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Example: a session listed at {inr(EXAMPLE_LIST_PRICE_PAISE)}
              </CardTitle>
              <CardDescription>
                An illustration of how the numbers work. It is not a price list;
                actual prices are set by each expert.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">
                  What you pay (buyer in India)
                </h3>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">
                      {gstRegistered
                        ? "Price set by the expert (before GST)"
                        : "Price listed by the expert"}
                    </dt>
                    <dd>{inr(EXAMPLE_LIST_PRICE_PAISE)}</dd>
                  </div>
                  {gstRegistered && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">
                        GST at {TAX_CONSTANTS.GST_RATE}%
                      </dt>
                      <dd>{inr(exampleGstPaise)}</dd>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between gap-4 font-semibold">
                    <dt>Total at checkout</dt>
                    <dd>{inr(totalPaise)}</dd>
                  </div>
                </dl>
              </div>
              <div>
                <h3 className="font-semibold mb-2">
                  What the expert receives (on a marketplace booking)
                </h3>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">
                      Platform fee ({PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE}%
                      of the listed price)
                    </dt>
                    <dd>{inr(exampleFeePaise)}</dd>
                  </div>
                  <Separator />
                  <div className="flex justify-between gap-4 font-semibold">
                    <dt>Expert&apos;s share</dt>
                    <dd>{inr(EXAMPLE_LIST_PRICE_PAISE - exampleFeePaise)}</dd>
                  </div>
                </dl>
              </div>
              <p className="text-xs text-muted-foreground">
                {gstRegistered
                  ? "Any discount or promotion is applied to the listed price before GST is calculated. The price on each card already includes this GST. "
                  : "No GST is added at the moment, so the price you see is the price you pay. "}
                The platform fee is paid out of the expert&apos;s share and is
                never added to your total. Tax deducted at source, where the law
                requires it, is a separate statutory deduction from the
                expert&apos;s payout.
                {gstRegistered &&
                  " Buyers outside India see the tax that applies to them at checkout."}
              </p>
            </CardContent>
          </Card>

          {/* Platform Fee */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">Platform Fee</CardTitle>
              <CardDescription>
                What Familiarise charges, and who pays it
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Familiarise charges experts a platform fee of currently{" "}
                <strong>{PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE}%</strong> of
                the listed price on each booking made through the marketplace.
                Learners do not pay it separately; it is already part of the
                listed price. The fee helps us:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                {PRICING_DATA.commissionBenefits.map((benefit) => (
                  <li key={benefit}>{benefit}</li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* Service Categories */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Service Categories
              </CardTitle>
              <CardDescription>
                The kinds of learning you can book on Familiarise
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6">
                {SERVICES.map((service) => (
                  <div
                    key={service.title}
                    className="flex gap-4 p-4 border border-border rounded-lg"
                  >
                    <div className="flex-shrink-0">
                      <service.icon className="h-8 w-8 text-foreground" />
                    </div>
                    <div className="flex-grow">
                      <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                        {service.title}
                        <Badge variant="secondary">{service.badge}</Badge>
                      </h3>
                      <p className="text-sm text-muted-foreground mb-3">
                        {service.description}
                      </p>
                      <p className="text-sm">
                        <strong>Pricing:</strong> {service.pricing}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Payment Information */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Payment Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Accepted Payment Methods</h3>
                <p className="text-muted-foreground mb-2">
                  We accept a wide range of payment methods through our secure
                  payment partner, Razorpay:
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRICING_DATA.paymentMethods.map((method) => (
                    <Badge key={method} variant="outline">
                      {method}
                    </Badge>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Currency</h3>
                <p className="text-muted-foreground">
                  All prices are in <strong>INR (Indian Rupees)</strong>.
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Security</h3>
                <p className="text-muted-foreground">
                  Payments are processed securely by Razorpay. Your card details
                  are entered with Razorpay and are not stored on our servers.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* FAQ Section */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Frequently Asked Questions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {pricingFaqs(gstRegistered).map((faq, index) => (
                  <AccordionItem key={faq.question} value={`item-${index + 1}`}>
                    <AccordionTrigger>{faq.question}</AccordionTrigger>
                    <AccordionContent>
                      {faq.answer}
                      {faq.question.includes("refund") && (
                        <>
                          {" "}
                          Please refer to our{" "}
                          <Link
                            href="/refund"
                            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                          >
                            Cancellation & Refund Policy
                          </Link>{" "}
                          for detailed information.
                        </>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>

          {/* CTA Section */}
          <Card className="bg-secondary border-border shadow-elevation-2">
            <CardContent className="text-center py-8">
              <h3 className="text-fluid-2xl font-bold tracking-tight mb-4">
                Ready to Start Learning?
              </h3>
              <p className="text-muted-foreground mb-6 max-w-2xl mx-auto">
                Browse our experts and programs, compare what they offer, and
                see the exact price before you book.
              </p>
              <div className="flex gap-4 justify-center flex-wrap">
                <Link href="/explore/experts">
                  <Button size="lg">Explore Experts</Button>
                </Link>
                <Link href="/explore/programs">
                  <Button size="lg" variant="outline">
                    Browse Programs
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
