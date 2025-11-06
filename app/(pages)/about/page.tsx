"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Users, Target, Award, BookOpen } from "lucide-react";

export default function AboutPage() {
  return (
    <section className="w-full xl:pt-32 lg:pt-24 md:pt-20 pt-16">
      <div className="container mx-auto px-4 md:px-6 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">About Familiarise</h1>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Connecting expert consultants with learners worldwide through live, interactive educational experiences
          </p>
        </div>

        {/* Main Content */}
        <div className="max-w-4xl mx-auto space-y-8">

          {/* Mission & Vision */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Target className="h-6 w-6" />
                <CardTitle className="text-2xl">Our Mission & Vision</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold text-lg mb-2">Mission</h3>
                <p className="text-muted-foreground">
                  To democratize access to quality education by connecting learners with expert consultants
                  and educators from around the world. We strive to make personalized learning accessible,
                  affordable, and effective for everyone.
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold text-lg mb-2">Vision</h3>
                <p className="text-muted-foreground">
                  To become the world's leading platform for live, interactive learning experiences where
                  knowledge flows freely between experts and learners, fostering a global community of
                  continuous growth and development.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* What We Offer */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <BookOpen className="h-6 w-6" />
                <CardTitle className="text-2xl">What We Offer</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Live Classes</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Interactive group learning sessions with scheduled appointments and real-time engagement
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Webinars</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Large-scale educational events and workshops on diverse topics
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">1-on-1 Consultations</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Personalized expert guidance sessions tailored to your specific needs
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Subscriptions</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Ongoing learning programs with recurring sessions and continuous support
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* How It Works */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="h-6 w-6" />
                <CardTitle className="text-2xl">How It Works</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">
                    1
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Discover Experts</h4>
                    <p className="text-sm text-muted-foreground">
                      Browse our curated list of verified consultants and educators across various domains
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">
                    2
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Book & Pay Securely</h4>
                    <p className="text-sm text-muted-foreground">
                      Choose your session, schedule your appointment, and make secure payments through our integrated payment system
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">
                    3
                  </div>
                  <div>
                    <h4 className="font-semibold mb-1">Learn & Grow</h4>
                    <p className="text-sm text-muted-foreground">
                      Join live sessions via integrated video conferencing, interact in real-time, and access course materials
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Platform Benefits */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Award className="h-6 w-6" />
                <CardTitle className="text-2xl">Why Choose Familiarise</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">Verified Experts</p>
                    <p className="text-sm text-muted-foreground">All consultants are verified and reviewed by students</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">Secure Payments</p>
                    <p className="text-sm text-muted-foreground">Industry-standard payment processing with Razorpay</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">Flexible Scheduling</p>
                    <p className="text-sm text-muted-foreground">Book sessions at your convenience with real-time availability</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">Integrated Platform</p>
                    <p className="text-sm text-muted-foreground">Video conferencing, chat, and materials all in one place</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">Transparent Pricing</p>
                    <p className="text-sm text-muted-foreground">Clear pricing with no hidden fees</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-green-600 mt-1">✓</div>
                  <div>
                    <p className="font-semibold">24/7 Support</p>
                    <p className="text-sm text-muted-foreground">Dedicated customer support to help you anytime</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Company Information */}
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Company Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Business Name</p>
                <p>[COMPANY NAME]</p>
              </div>
              <Separator />
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Registered Address</p>
                <p>[ADDRESS]</p>
              </div>
              <Separator />
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Contact Email</p>
                <p className="text-blue-600">
                  <a href="mailto:[EMAIL]">[EMAIL]</a>
                </p>
              </div>
              <Separator />
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Support</p>
                <p>
                  For any questions or support, please{" "}
                  <a href="/contactus" className="text-blue-600 hover:underline">
                    contact us
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </section>
  );
}
