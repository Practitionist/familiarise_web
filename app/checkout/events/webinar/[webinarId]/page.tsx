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
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

import type { TWebinar } from "@/types/appointment";

type WebinarResponse = {
  data: TWebinar;
};

const webinarSchema = z.object({
  discountCode: z.string().optional(),
});

type PageProps = {
  params: Promise<{ webinarId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function WebinarCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);

  const [planData, setPlanData] = useState<WebinarResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
  const { toast } = useToast();

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        if (!planData?.data?.webinarPlan?.id) {
          throw new Error("Webinar plan not found");
        }

        // In development or test mode, directly create the webinar registration
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
              appointmentType: "WEBINAR",
              planId: planData.data.webinarPlan.id,
              eventId: resolvedParams.webinarId,
              paymentGateway: gateway,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            const errorMessage = errorData.error || "Registration failed";
            const errorType = errorData.errorType || "UNKNOWN_ERROR";

            // Show specific toast based on error type
            switch (errorType) {
              case "PAYMENT_CONFIG_ERROR":
                toast({
                  title: "Payment System Error",
                  description:
                    "Payment system unavailable. Please contact support.",
                  variant: "destructive",
                });
                break;
              case "PAYMENT_PROCESSING_ERROR":
                toast({
                  title: "Payment Error",
                  description:
                    "Payment processing error. Please try again later.",
                  variant: "destructive",
                });
                break;
              case "DATABASE_ERROR":
                toast({
                  title: "System Error",
                  description: "System error. Please try again.",
                  variant: "destructive",
                });
                break;
              case "NOT_FOUND_ERROR":
                toast({
                  title: "Not Found",
                  description: errorMessage,
                  variant: "destructive",
                });
                break;
              case "AVAILABILITY_ERROR":
                toast({
                  title: "Registration Unavailable",
                  description: errorMessage,
                  variant: "destructive",
                });
                break;
              default:
                toast({
                  title: "Registration Failed",
                  description: errorMessage,
                  variant: "destructive",
                });
            }
            throw new Error(errorMessage);
          }

          const data = await response.json();

          // Show success toast
          toast({
            title: "✅ Webinar Registration Successful!",
            description: data.skipPayment
              ? "You're registered for the webinar. Check your dashboard for details."
              : "Payment processed successfully. You're registered for the webinar.",
            variant: "default",
          });

          // Redirect after a short delay to let user see the toast
          setTimeout(() => {
            window.location.href = "/dashboard/consultee";
          }, 2000);
          return;
        }

        // In production, proceed with payment gateway checkout
        const response = await fetch("/api/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            appointmentType: "WEBINAR",
            planId: planData.data.webinarPlan.id,
            eventId: resolvedParams.webinarId,
            paymentGateway: gateway,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          const errorMessage = errorData.error || "Checkout failed";
          const errorType = errorData.errorType || "UNKNOWN_ERROR";

          // Show specific toast based on error type for production flow
          switch (errorType) {
            case "PAYMENT_CONFIG_ERROR":
              toast({
                title: "Payment System Error",
                description:
                  "Payment system unavailable. Please contact support.",
                variant: "destructive",
              });
              break;
            case "PAYMENT_PROCESSING_ERROR":
              toast({
                title: "Payment Error",
                description:
                  "Payment processing error. Please try again later.",
                variant: "destructive",
              });
              break;
            case "DATABASE_ERROR":
              toast({
                title: "System Error",
                description: "System error. Please try again.",
                variant: "destructive",
              });
              break;
            case "NOT_FOUND_ERROR":
              toast({
                title: "Not Found",
                description: errorMessage,
                variant: "destructive",
              });
              break;
            case "AVAILABILITY_ERROR":
              toast({
                title: "Registration Unavailable",
                description: errorMessage,
                variant: "destructive",
              });
              break;
            default:
              toast({
                title: "Checkout Failed",
                description: errorMessage,
                variant: "destructive",
              });
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();

        // Handle gateway-specific responses
        switch (gateway) {
          case "STRIPE": {
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
          }

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
    [resolvedParams.webinarId, planData, toast],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/events/webinars/${resolvedParams.webinarId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.webinarPlan?.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(
          data.data.webinarPlan.consultantProfile?.id ?? "",
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
  }, [resolvedParams.webinarId]);

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

  const consultantDetails = planData?.data?.webinarPlan?.consultantProfile;
  const userDetails = planData?.data?.webinarPlan?.consultantProfile?.user;
  const nextSession =
    planData?.data?.appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;

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
            <div className="font-semibold">Webinar</div>
            <div className="text-sm text-muted-foreground">
              {planData?.data?.webinarPlan?.title ?? "Live Session"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Webinar Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Next Session</div>
              <div>
                {nextSession
                  ? new Date(nextSession).toLocaleString(undefined, {
                      dateStyle: "long",
                      timeStyle: "short",
                      timeZone:
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                    })
                  : "To be announced"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planData?.data?.webinarPlan?.durationInHours ?? 1} hours
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>
                {planData?.data?.webinarPlan?.maxParticipants ?? 100} attendees
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Platform</div>
              <div>
                {planData?.data?.webinarPlan?.materialProvided ?? "Zoom"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planData?.data?.webinarPlan?.language ?? "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planData?.data?.webinarPlan?.level ?? "All Levels"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Topics</div>
              <div>
                {planData?.data?.webinarPlan?.topics
                  ?.map((topic) => topic.name)
                  .join(", ") ?? "General"}
              </div>
            </div>
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
                <div className="font-medium">WEBINAR15</div>
                <div className="text-sm text-muted-foreground">
                  Get 15% off your webinar registration
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">15% off</div>
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
            <CardTitle>Webinar Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Registration Fee</div>
                <div>${planData?.data?.webinarPlan?.price ?? 50}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>Live webinar access</li>
                    <li>Q&A session</li>
                    <li>Session recording</li>
                    <li>Learning materials</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>${planData?.data?.webinarPlan?.price ?? 50}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>
                  $
                  {((planData?.data?.webinarPlan?.price ?? 50) * 0.1).toFixed(
                    2,
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (15%)</div>
                <div>
                  -$
                  {((planData?.data?.webinarPlan?.price ?? 50) * 0.15).toFixed(
                    2,
                  )}
                </div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>
                  $
                  {((planData?.data?.webinarPlan?.price ?? 50) * 0.95).toFixed(
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
