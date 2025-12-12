"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { DollarSign, Users, Video, Calendar, Repeat } from "lucide-react";

export default function PricingPage() {
  return (
    <section className="w-full xl:pt-32 lg:pt-24 md:pt-20 pt-16">
      <div className="container mx-auto px-4 md:px-6 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Pricing</h1>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Transparent, consultant-driven pricing with no hidden fees
          </p>
        </div>

        <div className="max-w-4xl mx-auto space-y-8">
          {/* Pricing Model Overview */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <DollarSign className="h-6 w-6" />
                <CardTitle className="text-2xl">
                  How Our Pricing Works
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                At Familiarise, we believe in empowering consultants to set
                their own prices based on their expertise, experience, and the
                value they provide. Our platform operates on a
                <strong> dynamic pricing model</strong> where:
              </p>
              <div className="bg-muted p-4 rounded-lg space-y-2">
                <p className="flex items-start gap-2">
                  <span className="text-green-600 mt-1">✓</span>
                  <span>
                    <strong>Consultants set their own rates</strong> based on
                    their expertise and market demand
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-green-600 mt-1">✓</span>
                  <span>
                    <strong>You see the exact price</strong> before booking any
                    session
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-green-600 mt-1">✓</span>
                  <span>
                    <strong>No hidden fees</strong> - the displayed price is
                    what you pay
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-green-600 mt-1">✓</span>
                  <span>
                    <strong>Platform commission</strong> is already included in
                    the price
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Platform Commission */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Platform Commission</CardTitle>
              <CardDescription>
                Our commission structure enables us to maintain and improve the
                platform
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Familiarise charges a small platform fee on each transaction.
                This fee helps us:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                <li>Maintain secure payment processing infrastructure</li>
                <li>
                  Provide integrated video conferencing and communication tools
                </li>
                <li>Host and deliver course materials and content</li>
                <li>Ensure platform security and data protection</li>
                <li>Offer 24/7 customer support</li>
                <li>Continuously improve the user experience</li>
              </ul>
              <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Note:</strong> The commission is automatically
                  included in the prices shown to students. Consultants receive
                  their earnings after the platform fee is deducted.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Service Categories */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Service Categories</CardTitle>
              <CardDescription>
                Explore the different types of services available on our
                platform
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6">
                {/* Consultations */}
                <div className="flex gap-4 p-4 border rounded-lg">
                  <div className="flex-shrink-0">
                    <Users className="h-8 w-8 text-blue-600" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      One-on-One Consultations
                      <Badge variant="secondary">Per Session</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Personalized expert guidance sessions tailored to your
                      specific needs. Duration typically ranges from 30 minutes
                      to 2 hours.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Varies by consultant expertise
                      and session duration. Consultants set their own rates.
                    </p>
                  </div>
                </div>

                {/* Classes */}
                <div className="flex gap-4 p-4 border rounded-lg">
                  <div className="flex-shrink-0">
                    <Calendar className="h-8 w-8 text-green-600" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Live Interactive Classes
                      <Badge variant="secondary">Course-based</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Group learning sessions with scheduled appointments.
                      Includes multiple sessions over weeks or months, course
                      materials, and certificates.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Varies by course duration,
                      number of sessions, and consultant expertise. Full course
                      payment required at enrollment.
                    </p>
                  </div>
                </div>

                {/* Webinars */}
                <div className="flex gap-4 p-4 border rounded-lg">
                  <div className="flex-shrink-0">
                    <Video className="h-8 w-8 text-purple-600" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Webinars & Workshops
                      <Badge variant="secondary">Event-based</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Large-scale educational events and workshops on specific
                      topics. Typically 1-3 hours long with Q&A sessions.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Generally more affordable than
                      1-on-1 sessions due to group participation. Set by event
                      organizer.
                    </p>
                  </div>
                </div>

                {/* Subscriptions */}
                <div className="flex gap-4 p-4 border rounded-lg">
                  <div className="flex-shrink-0">
                    <Repeat className="h-8 w-8 text-orange-600" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Subscription Plans
                      <Badge variant="secondary">Recurring</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Ongoing learning programs with recurring sessions.
                      Includes regular meetings, continuous support, and
                      progressive curriculum.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Monthly or course-based
                      subscriptions. Varies by frequency of sessions and
                      duration of commitment.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Information */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Payment Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Accepted Payment Methods</h3>
                <p className="text-muted-foreground mb-2">
                  We accept a wide range of payment methods through our secure
                  payment partner, Razorpay:
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">Credit Cards</Badge>
                  <Badge variant="outline">Debit Cards</Badge>
                  <Badge variant="outline">UPI</Badge>
                  <Badge variant="outline">Net Banking</Badge>
                  <Badge variant="outline">Wallets</Badge>
                </div>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Currency</h3>
                <p className="text-muted-foreground">
                  All prices are displayed in{" "}
                  <strong>INR (Indian Rupees)</strong> unless otherwise
                  specified.
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Security</h3>
                <p className="text-muted-foreground">
                  All payments are processed securely through Razorpay with
                  industry-standard encryption. Your payment information is
                  never stored on our servers.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* FAQ Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">
                Frequently Asked Questions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="item-1">
                  <AccordionTrigger>
                    How do I know the price before booking?
                  </AccordionTrigger>
                  <AccordionContent>
                    The price for each service is clearly displayed on the
                    consultant's profile and on the booking page. You will see
                    the exact amount you need to pay before confirming your
                    booking.
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="item-2">
                  <AccordionTrigger>
                    Are there any additional fees?
                  </AccordionTrigger>
                  <AccordionContent>
                    No, there are no hidden fees. The price displayed is the
                    final amount you will pay. The platform commission is
                    already included in the displayed price.
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="item-3">
                  <AccordionTrigger>
                    Can I get a refund if I cancel?
                  </AccordionTrigger>
                  <AccordionContent>
                    Yes, refunds are available based on our cancellation policy.
                    The refund eligibility depends on when you cancel and the
                    type of service. Please refer to our{" "}
                    <Link
                      href="/refund"
                      className="text-blue-600 hover:underline"
                    >
                      Cancellation & Refund Policy
                    </Link>{" "}
                    for detailed information.
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="item-4">
                  <AccordionTrigger>
                    Why do prices vary between consultants?
                  </AccordionTrigger>
                  <AccordionContent>
                    Consultants set their own prices based on their expertise,
                    experience, qualifications, and market demand. This allows
                    you to choose consultants that fit your budget while
                    ensuring consultants are fairly compensated for their
                    knowledge and time.
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="item-5">
                  <AccordionTrigger>
                    Do you offer discounts or promotional pricing?
                  </AccordionTrigger>
                  <AccordionContent>
                    Individual consultants may offer promotional pricing or
                    discounts for their services. These will be clearly
                    displayed on their profiles and during the booking process.
                    We also occasionally run platform-wide promotions -
                    subscribe to our newsletter to stay updated.
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="item-6">
                  <AccordionTrigger>How are consultants paid?</AccordionTrigger>
                  <AccordionContent>
                    Consultants receive their earnings after the session is
                    completed successfully. The platform commission is
                    automatically deducted, and the remaining amount is
                    transferred to the consultant's registered bank account
                    according to the settlement schedule.
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* CTA Section */}
          <Card className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950 dark:to-purple-950 border-0">
            <CardContent className="text-center py-8">
              <h3 className="text-2xl font-bold mb-4">
                Ready to Start Learning?
              </h3>
              <p className="text-muted-foreground mb-6 max-w-2xl mx-auto">
                Browse our consultants, explore their expertise, and find the
                perfect match for your learning goals. Transparent pricing,
                secure payments, quality education.
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
