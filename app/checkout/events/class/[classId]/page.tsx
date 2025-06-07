"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";
import type { ConsultantReview } from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/components/ui/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

import type { TClass } from "@/types/appointment";

type ClassResponse = {
  data: TClass;
};

const classSchema = z.object({
  discountCode: z.string().optional(),
});

type PageProps = {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const [planData, setPlanData] = useState<ClassResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
  const { toast } = useToast();

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        // Validate params first
        const parsedParams = classSchema.safeParse(resolvedSearchParams);
        if (!parsedParams.success) {
          throw new Error("Invalid class parameters");
        }

        // In development or test mode, directly create the class registration
        if (
          process.env.NODE_ENV === "development" ||
          process.env.NODE_ENV === "test"
        ) {
          const response = await fetch("/api/checkout", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "class",
              classId: resolvedParams.classId,
              discountCode: parsedParams.data.discountCode,
              paymentGateway: gateway,
            }),
          });

          if (!response.ok) {
            throw new Error("Registration failed");
          }

          window.location.href = "/dashboard/consultee";
          return;
        }

        // In production, proceed with payment gateway checkout
        const response = await fetch("/api/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "class",
            classId: resolvedParams.classId,
            discountCode: parsedParams.data.discountCode,
            paymentGateway: gateway,
          }),
        });

        if (!response.ok) {
          throw new Error("Checkout failed");
        }

        const data = await response.json();

        // Handle gateway-specific responses
        switch (gateway) {
          case "STRIPE":
            // Load Stripe.js and redirect to checkout
            const stripeInstance = await loadStripe(
              process.env.NEXT_PUBLIC_STRIPE_KEY!,
            );
            if (!stripeInstance) {
              throw new Error("Failed to load Stripe");
            }
            await stripeInstance.confirmPayment({
              clientSecret: data.clientSecret,
              confirmParams: {
                return_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`,
              },
            });
            break;

          case "RAZORPAY":
            // Redirect to Razorpay checkout
            window.location.href = `/checkout/razorpay?order_id=${data.orderId}`;
            break;

          case "LEMON_SQUEEZY":
          case "XFLOW":
            // Direct URL redirect
            window.location.href = data.checkoutUrl;
            break;
        }
      } catch (error) {
        console.error("Checkout error:", error);
        toast({
          title: "Checkout Failed",
          description:
            error instanceof Error ? error.message : "Please try again",
          variant: "destructive",
        });
      }
    },
    [resolvedParams, resolvedSearchParams, toast],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/events/classes/${resolvedParams.classId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.classPlan?.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(
          data.data.classPlan.consultantProfile?.id ?? "",
        );
        _setReviews(reviewsData);
      } catch (error) {
        console.error("Error fetching plan data:", error);
        setError(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred. Please try again.",
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchPlanData();
  }, [resolvedParams.classId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div
          className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 max-w-lg mx-auto text-center"
          role="alert"
        >
          <p className="font-bold">Oops! Something went wrong</p>
          <p>{error}</p>
          <p className="mt-2">
            Please check your selection and try again. If the problem persists,
            contact support.
          </p>
        </div>
      </div>
    );
  }

  const consultantDetails = planData?.data?.classPlan?.consultantProfile;
  const userDetails = planData?.data?.classPlan?.consultantProfile?.user;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[60%_40%] min-h-screen">
      <div className="flex flex-col gap-8 border-r bg-muted/40 p-8 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Avatar className="w-12 h-12 border">
              <AvatarImage
                src={userDetails?.image ?? "/placeholder-user.jpg"}
                alt={userDetails?.name ?? "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">
                {userDetails?.name ?? "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground">
                {consultantDetails?.specialization ?? "Consultant"}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">Class</div>
            <div className="text-sm text-muted-foreground">
              {planData?.data?.classPlan?.title ?? "Learning Program"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Class Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planData?.data?.classPlan?.durationInMonths ?? 1} months
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>
                {planData?.data?.classPlan?.maxParticipants ?? 10} students
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Calls per Week</div>
              <div>{planData?.data?.classPlan?.callsPerWeek ?? 1} calls</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Video Meetings</div>
              <div>
                {planData?.data?.classPlan?.videoMeetings ?? 1} per month
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Email Support</div>
              <div>{planData?.data?.classPlan?.emailSupport ?? "General"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Certificate</div>
              <div>
                {planData?.data?.classPlan?.certificateProvided ? "Yes" : "No"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Topics</div>
              <div>
                {planData?.data?.classPlan?.topics
                  ?.map((topic) => topic.name)
                  .join(", ") ?? "General"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planData?.data?.classPlan?.language ?? "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planData?.data?.classPlan?.level ?? "Beginner"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planData?.data?.classPlan?.prerequisites ?? "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planData?.data?.classPlan?.materialProvided ?? "None"}</div>
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-4">
          <div className="font-semibold">Course Content</div>
          <div className="grid gap-4">
            {planData?.data?.classPlan?.classContents?.map((content, index) => (
              <div key={content.id} className="grid gap-1">
                <div className="font-medium">
                  Module {index + 1}: {content.title}
                </div>
                <div className="text-sm text-muted-foreground">
                  {content.description}
                </div>
                <div className="text-sm text-muted-foreground">
                  Duration: {content.hoursAllotted} hours
                </div>
              </div>
            ))}
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-4">
          <div className="font-semibold">Discount Codes</div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Enter discount code"
              className="flex-1"
            />
            <Button variant="outline">Apply</Button>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">CLASS25</div>
                <div className="text-sm text-muted-foreground">
                  Get 25% off your class registration
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">25% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-8 overflow-y-auto">
        <Card>
          <CardHeader>
            <CardTitle>Class Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Course Fee</div>
                <div>${planData?.data?.classPlan?.price ?? 500}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>
                      {planData?.data?.classPlan?.callsPerWeek ?? 1} calls per
                      week
                    </li>
                    <li>
                      {planData?.data?.classPlan?.videoMeetings ?? 1} video
                      meetings
                    </li>
                    <li>
                      {planData?.data?.classPlan?.emailSupport ?? "General"}{" "}
                      email support
                    </li>
                    <li>Course materials</li>
                    {planData?.data?.classPlan?.certificateProvided && (
                      <li>Completion certificate</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>${planData?.data?.classPlan?.price ?? 500}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>
                  $
                  {((planData?.data?.classPlan?.price ?? 500) * 0.1).toFixed(2)}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (25%)</div>
                <div>
                  -$
                  {((planData?.data?.classPlan?.price ?? 500) * 0.25).toFixed(
                    2,
                  )}
                </div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>
                  $
                  {((planData?.data?.classPlan?.price ?? 500) * 0.85).toFixed(
                    2,
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="font-semibold">Payment</div>
            <div className="text-muted-foreground">
              Select your preferred payment method
            </div>
          </div>
          {/* Payment Gateway Cards */}
          {[
            {
              name: "Stripe",
              description: "International payments in USD",
              gateway: "STRIPE" as const,
            },
            {
              name: "Razorpay",
              description: "Indian payments in INR",
              gateway: "RAZORPAY" as const,
            },
            {
              name: "Lemon Squeezy",
              description: "Global payments in USD",
              gateway: "LEMON_SQUEEZY" as const,
            },
            {
              name: "Xflow",
              description: "Secure payments in USD",
              gateway: "XFLOW" as const,
            },
          ].map((gateway) => (
            <Card key={gateway.name}>
              <CardHeader>
                <CardTitle>{gateway.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <CreditCardIcon className="w-8 h-8" />
                    <div>
                      <div className="font-semibold">Credit/Debit Card</div>
                      <div className="text-sm text-muted-foreground">
                        {gateway.description}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => handleCheckout(gateway.gateway)}
                  >
                    Pay with {gateway.name}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
