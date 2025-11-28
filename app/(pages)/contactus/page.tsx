"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Mail, MapPin, Phone, Clock, MessageSquare } from "lucide-react";

export default function ContactUsPage() {
  return (
    <section className="w-full xl:pt-32 lg:pt-24 md:pt-20 pt-16">
      <div className="container mx-auto px-4 md:px-6 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <MessageSquare className="h-16 w-16 text-blue-600" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Contact Us</h1>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            We're here to help! Reach out to us with any questions, concerns, or feedback.
          </p>
        </div>

        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-8">

          {/* Contact Information */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-2xl">Get in Touch</CardTitle>
                <CardDescription>
                  Our team is available to assist you with any inquiries
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">

                {/* Company Address */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
                    <MapPin className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Address</h3>
                    <p className="text-sm text-muted-foreground">
                      [COMPANY NAME]<br />
                      [ADDRESS]
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Email */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-green-100 dark:bg-green-950 flex items-center justify-center">
                    <Mail className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Email</h3>
                    <p className="text-sm text-muted-foreground">
                      General Inquiries:{" "}
                      <a href="mailto:[EMAIL]" className="text-blue-600 hover:underline">
                        [EMAIL]
                      </a>
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Support:{" "}
                      <a href="mailto:[SUPPORT_EMAIL]" className="text-blue-600 hover:underline">
                        [SUPPORT_EMAIL]
                      </a>
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Phone */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-950 flex items-center justify-center">
                    <Phone className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Phone</h3>
                    <p className="text-sm text-muted-foreground">
                      <a href="tel:[PHONE]" className="text-blue-600 hover:underline">
                        [PHONE]
                      </a>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      (Available during business hours)
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Business Hours */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-orange-100 dark:bg-orange-950 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-orange-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Business Hours</h3>
                    <p className="text-sm text-muted-foreground">
                      Monday - Friday: 9:00 AM - 6:00 PM IST<br />
                      Saturday: 10:00 AM - 4:00 PM IST<br />
                      Sunday: Closed
                    </p>
                  </div>
                </div>

              </CardContent>
            </Card>

            {/* Support Information */}
            <Card>
              <CardHeader>
                <CardTitle>Support Resources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Before contacting us, you may find answers to your questions in our help resources:
                </p>
                <ul className="space-y-2">
                  <li className="text-sm">
                    <a href="/pricing" className="text-blue-600 hover:underline">
                      • Pricing & Platform Fees
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="/refund" className="text-blue-600 hover:underline">
                      • Cancellation & Refund Policy
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="/privacy" className="text-blue-600 hover:underline">
                      • Privacy Policy
                    </a>
                  </li>
                  <li className="text-sm">
                    <a href="/terms" className="text-blue-600 hover:underline">
                      • Terms & Conditions
                    </a>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Contact Form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Send us a Message</CardTitle>
              <CardDescription>
                Fill out the form below and we'll get back to you as soon as possible
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="first-name">
                      First name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="first-name"
                      placeholder="Enter your first name"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="last-name">
                      Last name <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="last-name"
                      placeholder="Enter your last name"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">
                    Email <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="email"
                    placeholder="Enter your email"
                    required
                    type="email"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phone">Phone (optional)</Label>
                  <Input
                    id="phone"
                    placeholder="Enter your phone number"
                    type="tel"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subject">
                    Subject <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="subject"
                    placeholder="What is this regarding?"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="message">
                    Message <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    className="min-h-[150px]"
                    id="message"
                    placeholder="Enter your message"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category">Inquiry Type</Label>
                  <select
                    id="category"
                    className="w-full px-3 py-2 border rounded-md bg-background"
                  >
                    <option value="">Select a category</option>
                    <option value="general">General Inquiry</option>
                    <option value="technical">Technical Support</option>
                    <option value="billing">Billing & Payments</option>
                    <option value="booking">Booking Issues</option>
                    <option value="consultant">Consultant Support</option>
                    <option value="feedback">Feedback</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <Button className="w-full" type="submit" size="lg">
                  Send Message
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  We typically respond within 24-48 hours during business days
                </p>
              </form>
            </CardContent>
          </Card>

        </div>

        {/* Additional Information */}
        <div className="max-w-6xl mx-auto mt-8">
          <Card>
            <CardContent className="p-6">
              <div className="grid md:grid-cols-3 gap-6 text-center">
                <div>
                  <h3 className="font-semibold mb-2">Quick Response</h3>
                  <p className="text-sm text-muted-foreground">
                    We aim to respond to all inquiries within 24-48 hours
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Professional Support</h3>
                  <p className="text-sm text-muted-foreground">
                    Our dedicated team is here to assist with any questions
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Multiple Channels</h3>
                  <p className="text-sm text-muted-foreground">
                    Reach us via email, phone, or contact form
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>
    </section>
  );
}
