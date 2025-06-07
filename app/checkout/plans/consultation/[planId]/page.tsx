"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";
import {
  ConsultantProfile,
  ConsultantReview,
  ConsultationPlan,
} from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

type ConsultationPlanWithConsultant = ConsultationPlan & {
  consultantProfile: ConsultantProfile & {
    user: {
      id: string;
      name: string;
      email: string;
      image: string;
    };
  };
};

type ConsultationResponse = {
  data: ConsultationPlanWithConsultant;
};

const consultationSchema = z
  .object({
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    slotStartTimeInUTC: z.string().datetime(),
    slotEndTimeInUTC: z.string().datetime(),
    discountCode: z.string().optional(),
  })
  .refine(
    (data) =>
      (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
      (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message:
        "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
      path: ["slotOfAvailabilityWeeklyId", "slotOfAvailabilityCustomId"],
    },
  )
  .refine(
    (data) =>
      new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC),
    {
      message: "Start time must be before end time",
      path: ["slotStartTime", "slotEndTime"],
    },
  );

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsultationCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const [eventData, setEventData] = useState<ConsultationResponse | null>(null);
  const [slotData, setSlotData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);

  // Fetch slot details
  useEffect(() => {
    async function fetchSlotData() {
      try {
        const { slotOfAvailabilityWeeklyId, slotOfAvailabilityCustomId } =
          resolvedSearchParams;

        if (slotOfAvailabilityWeeklyId) {
          const response = await fetch(
            `/api/slots/availability/weekly/${slotOfAvailabilityWeeklyId}`,
          );
          if (response.ok) {
            const data = await response.json();
            setSlotData(data.data);
          }
        } else if (slotOfAvailabilityCustomId) {
          const response = await fetch(
            `/api/slots/availability/custom/${slotOfAvailabilityCustomId}`,
          );
          if (response.ok) {
            const data = await response.json();
            setSlotData(data.data);
          }
        }
      } catch (error) {
        console.error("Error fetching slot data:", error);
      }
    }

    if (
      resolvedSearchParams.slotOfAvailabilityWeeklyId ||
      resolvedSearchParams.slotOfAvailabilityCustomId
    ) {
      fetchSlotData();
    }
  }, [resolvedSearchParams]);
  const { toast } = useToast();

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        // Validate params first
        const parsedParams = consultationSchema.safeParse(resolvedSearchParams);
        if (!parsedParams.success) {
          throw new Error("Invalid booking parameters");
        }

        // In development or test mode, directly create the appointment
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
              appointmentType: "CONSULTATION",
              planId: resolvedParams.planId,
              slotOfAvailabilityWeeklyId:
                parsedParams.data.slotOfAvailabilityWeeklyId,
              slotOfAvailabilityCustomId:
                parsedParams.data.slotOfAvailabilityCustomId,
              slotStartTimeInUTC: parsedParams.data.slotStartTimeInUTC,
              slotEndTimeInUTC: parsedParams.data.slotEndTimeInUTC,
              discountCode: parsedParams.data.discountCode,
              paymentGateway: gateway,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            const errorMessage = errorData.error || "Booking failed";
            const errorType = errorData.errorType || "UNKNOWN_ERROR";
            
            // Show specific toast based on error type
            switch (errorType) {
              case "PAYMENT_CONFIG_ERROR":
                toast({
                  title: "Payment System Error",
                  description: "Payment system unavailable. Please contact support.",
                  variant: "destructive",
                });
                break;
              case "PAYMENT_PROCESSING_ERROR":
                toast({
                  title: "Payment Error",
                  description: "Payment processing error. Please try again later.",
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
                  title: "Booking Unavailable",
                  description: errorMessage,
                  variant: "destructive",
                });
                break;
              default:
                toast({
                  title: "Booking Failed",
                  description: errorMessage,
                  variant: "destructive",
                });
            }
            throw new Error(errorMessage);
          }

          const data = await response.json();
          
          // Show success toast
          toast({
            title: "✅ Consultation Booked Successfully!",
            description: data.skipPayment 
              ? "Your consultation has been confirmed. Check your dashboard for details."
              : "Payment processed successfully. Your consultation is confirmed.",
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
            appointmentType: "CONSULTATION",
            planId: resolvedParams.planId,
            slotOfAvailabilityWeeklyId:
              parsedParams.data.slotOfAvailabilityWeeklyId,
            slotOfAvailabilityCustomId:
              parsedParams.data.slotOfAvailabilityCustomId,
            slotStartTimeInUTC: parsedParams.data.slotStartTimeInUTC,
            slotEndTimeInUTC: parsedParams.data.slotEndTimeInUTC,
            discountCode: parsedParams.data.discountCode,
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
                description: "Payment system unavailable. Please contact support.",
                variant: "destructive",
              });
              break;
            case "PAYMENT_PROCESSING_ERROR":
              toast({
                title: "Payment Error",
                description: "Payment processing error. Please try again later.",
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
                title: "Booking Unavailable",
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
          case "STRIPE":
            // Load Stripe.js and redirect to checkout
            const stripe = await loadStripe(
              process.env.NEXT_PUBLIC_STRIPE_KEY!,
            );
            await stripe?.confirmPayment({
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
    async function fetchEventData() {
      setIsLoading(true);
      try {
        const parsedParams = consultationSchema.safeParse(resolvedSearchParams);

        if (!parsedParams.success) {
          const issues = parsedParams.error.issues;
          const missingFields = issues.map((issue) => issue.path[0]).join(", ");
          throw new Error(`Missing required fields: ${missingFields}`);
        }

        const endpoint = `/api/plans/consultations/${resolvedParams.planId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data.consultantProfile?.user) {
          throw new Error("Consultant details not found");
        }

        setEventData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(data.data.consultantProfile.id);
        setReviews(reviewsData);
      } catch (error) {
        console.error("Error fetching event data:", error);
        let errorMessage = "An unexpected error occurred. Please try again.";

        if (error instanceof Error) {
          if (error.message.includes("Missing required fields")) {
            errorMessage =
              error.message +
              ". Please ensure you have provided all necessary information.";
          } else {
            errorMessage = error.message;
          }
        }

        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    }

    fetchEventData();
  }, [resolvedParams.planId, resolvedSearchParams]);

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

  const consultantDetails = eventData?.data.consultantProfile;
  const userDetails = eventData?.data.consultantProfile.user;

  return (
    <>
      <div className="flex flex-col gap-8 border-r bg-muted/40 p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Avatar className="w-12 h-12 border">
              <AvatarImage
                src={userDetails?.image || "/placeholder-user.jpg"}
                alt={userDetails?.name || "Consultant"}
              />
              <AvatarFallback>
                {userDetails?.name ? userDetails.name.charAt(0) : "C"}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">
                {userDetails?.name || "Consultant Name"}
              </div>
              <div className="text-sm text-muted-foreground">
                {consultantDetails?.specialization || "Consultant"}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">Consultation</div>
            <div className="text-sm text-muted-foreground">
              {eventData?.data?.title || "One-on-One Session"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Consultation Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Date</div>
              <div>
                {new Date(
                  resolvedSearchParams.slotStartTimeInUTC as string,
                ).toLocaleDateString(undefined, {
                  weekday: "long",
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Time</div>
              <div>
                {new Date(
                  resolvedSearchParams.slotStartTimeInUTC as string,
                ).toLocaleTimeString()}{" "}
                -{" "}
                {new Date(
                  resolvedSearchParams.slotEndTimeInUTC as string,
                ).toLocaleTimeString()}{" "}
                ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>{eventData?.data?.durationInHours || 1} hours</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{eventData?.data?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{eventData?.data?.level || "Beginner"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{eventData?.data?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{eventData?.data?.materialProvided || "None"}</div>
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
                <div className="font-medium">CONSULT10</div>
                <div className="text-sm text-muted-foreground">
                  Get 10% off your consultation
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">10% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Consultation Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Session Fee</div>
                <div>${eventData?.data?.price || 100}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>One-on-one session</li>
                    <li>Personalized guidance</li>
                    <li>Session notes</li>
                    <li>Follow-up resources</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>${eventData?.data?.price || 100}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>${((eventData?.data?.price || 100) * 0.1).toFixed(2)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (10%)</div>
                <div>
                  -$
                  {((eventData?.data?.price || 100) * 0.1).toFixed(2)}
                </div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>${((eventData?.data?.price || 100) * 1).toFixed(2)}</div>
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
    </>
  );
}
