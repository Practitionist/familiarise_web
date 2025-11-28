"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { fetchReviews } from "@/lib/user";
import {
  CheckoutInput,
  checkoutResponseSchema,
  consultationSearchParamsSchema,
  createCheckoutData,
} from "@/schemas/checkout";
import {
  ConsultantProfile,
  ConsultantReview,
  ConsultationPlan,
  PaymentGateway,
} from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useCallback, useEffect, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";

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

// Using the shared consultation schema from utils/payments.ts

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
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );

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

  // Common error handling logic
  const handleApiError = (errorData: any) => {
    const errorMessage = errorData.error || "Operation failed";
    const errorType = errorData.errorType || "UNKNOWN_ERROR";

    const errorMessages = {
      PAYMENT_CONFIG_ERROR: {
        title: "Payment System Error",
        description: "Payment system unavailable. Please contact support.",
      },
      PAYMENT_PROCESSING_ERROR: {
        title: "Payment Error",
        description: "Payment processing error. Please try again later.",
      },
      DATABASE_ERROR: {
        title: "System Error",
        description: "System error. Please try again.",
      },
      NOT_FOUND_ERROR: {
        title: "Not Found",
        description: errorMessage,
      },
      AVAILABILITY_ERROR: {
        title: "Booking Unavailable",
        description: errorMessage,
      },
      UNKNOWN_ERROR: {
        title: "Operation Failed",
        description: errorMessage,
      },
    };

    const error =
      errorMessages[errorType as keyof typeof errorMessages] ||
      errorMessages.UNKNOWN_ERROR;

    toast({
      title: error.title,
      description: error.description,
      variant: "destructive",
    });
  };

  // Common API request logic
  const makeCheckoutRequest = async (
    checkoutData: CheckoutInput,
    gateway: string,
    isMockPayment: boolean = false,
  ) => {
    return fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...checkoutData, isMockPayment }),
    });
  };

  const handleCheckout = useCallback(
    async (
      gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW",
      isMockPayment: boolean = false,
    ) => {
      // Prevent double-clicks and multiple simultaneous requests
      if (isCheckoutProcessing) {
        return;
      }

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        // Validate search params first
        const searchParamsValidation =
          consultationSearchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          const issues = searchParamsValidation.error.issues;
          const missingFields = issues
            .map((issue) => {
              const fieldName = issue.path[0] || "unknown field";
              return `${fieldName}: ${issue.message}`;
            })
            .join(", ");
          throw new Error(
            `Missing required booking information: ${missingFields}. Please select a time slot before proceeding.`,
          );
        }

        // Create validated checkout data
        const checkoutData = createCheckoutData({
          appointmentType: "CONSULTATION",
          planId: resolvedParams.planId,
          paymentGateway: gateway as PaymentGateway,
          slotStartTimeInUTC: searchParamsValidation.data.slotStartTimeInUTC,
          slotEndTimeInUTC: searchParamsValidation.data.slotEndTimeInUTC,
          slotOfAvailabilityWeeklyId:
            searchParamsValidation.data.slotOfAvailabilityWeeklyId,
          slotOfAvailabilityCustomId:
            searchParamsValidation.data.slotOfAvailabilityCustomId,
          discountCode: searchParamsValidation.data.discountCode,
          notes: searchParamsValidation.data.notes,
        });

        // Make single API call - backend decides dev vs prod flow
        const response = await makeCheckoutRequest(
          checkoutData,
          gateway,
          isMockPayment,
        );

        if (!response.ok) {
          const errorData = await response.json();
          handleApiError(errorData);
          throw new Error(errorData.error || "Checkout failed");
        }

        const data = await response.json();

        // Validate response using schema
        const validatedResponse = checkoutResponseSchema.safeParse(data);
        if (!validatedResponse.success) {
          throw new Error("Invalid response format from server");
        }

        // Handle response based on what backend returns
        if (data.skipPayment || data.isMockPayment) {
          // Development mode or mock payment - direct booking success
          toast({
            title: "✅ Consultation Booked Successfully!",
            description: data.isMockPayment
              ? "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details."
              : "Your consultation has been confirmed. Check your dashboard for details.",
            variant: "default",
          });

          // Redirect after a short delay
          setTimeout(() => {
            window.location.href = "/dashboard";
          }, 2000);
        } else {
          // Production mode - payment initiated success
          toast({
            title: "🚀 Payment Initiated!",
            description:
              "Redirecting to secure payment gateway. Complete your payment to confirm the consultation.",
            variant: "default",
          });

          // Small delay to let user see the toast before redirect
          setTimeout(async () => {
            // Handle gateway-specific responses
            switch (gateway) {
              case "STRIPE":
                const stripe = await loadStripe(
                  process.env.NEXT_PUBLIC_STRIPE_KEY!,
                );
                await stripe?.confirmPayment({
                  clientSecret: data.paymentIntent.client_secret,
                  confirmParams: {
                    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/checkout-success`,
                  },
                });
                break;

              case "RAZORPAY":
                // Razorpay is handled by the RazorpayCheckout component
                // This case shouldn't be reached since Razorpay has its own component
                break;

              case "LEMON_SQUEEZY":
              case "XFLOW":
                window.location.href = data.paymentIntent.client_secret; // This would be the checkout URL for these gateways
                break;
            }
          }, 1000);
        }
      } catch (error) {
        console.error("Checkout error:", error);

        // Only show generic error if it wasn't already handled
        if (!(error instanceof Error && error.message.includes("failed"))) {
          toast({
            title: "Checkout Failed",
            description:
              error instanceof Error ? error.message : "Please try again",
            variant: "destructive",
          });
        }
      } finally {
        // Always reset loading state
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [resolvedParams, resolvedSearchParams, toast, isCheckoutProcessing],
  );

  useEffect(() => {
    async function fetchEventData() {
      setIsLoading(true);
      try {
        // Validate search params using Zod schema
        const searchParamsValidation =
          consultationSearchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          const issues = searchParamsValidation.error.issues;
          const missingFields = issues
            .map((issue) => {
              const fieldName = issue.path[0] || "unknown field";
              return `${fieldName}: ${issue.message}`;
            })
            .join(", ");
          throw new Error(
            `Missing required booking information: ${missingFields}. Please select a time slot from the consultant's availability page before proceeding to checkout.`,
          );
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
          {/* Priority Gateways: Stripe and Razorpay with Real + Mock Payment */}
          {[
            {
              name: "Stripe",
              description: "International payments in USD",
              gateway: "STRIPE" as const,
              isActive: true,
            },
            {
              name: "Razorpay",
              description: "Indian payments in INR",
              gateway: "RAZORPAY" as const,
              isActive: true,
            },
            {
              name: "Lemon Squeezy",
              description: "Global payments in USD (Coming Soon)",
              gateway: "LEMON_SQUEEZY" as const,
              isActive: false,
            },
            {
              name: "Xflow",
              description: "Secure payments in USD (Coming Soon)",
              gateway: "XFLOW" as const,
              isActive: false,
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
                  {gateway.isActive ? (
                    <div className="flex gap-2">
                      {/* Real Payment Button */}
                      {gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CONSULTATION",
                            planId: resolvedParams.planId,
                            paymentGateway: "RAZORPAY",
                            slotStartTimeInUTC: Array.isArray(
                              resolvedSearchParams.slotStartTimeInUTC,
                            )
                              ? resolvedSearchParams.slotStartTimeInUTC[0]
                              : resolvedSearchParams.slotStartTimeInUTC,
                            slotEndTimeInUTC: Array.isArray(
                              resolvedSearchParams.slotEndTimeInUTC,
                            )
                              ? resolvedSearchParams.slotEndTimeInUTC[0]
                              : resolvedSearchParams.slotEndTimeInUTC,
                            slotOfAvailabilityWeeklyId: Array.isArray(
                              resolvedSearchParams.slotOfAvailabilityWeeklyId,
                            )
                              ? resolvedSearchParams.slotOfAvailabilityWeeklyId[0]
                              : resolvedSearchParams.slotOfAvailabilityWeeklyId,
                            slotOfAvailabilityCustomId: Array.isArray(
                              resolvedSearchParams.slotOfAvailabilityCustomId,
                            )
                              ? resolvedSearchParams.slotOfAvailabilityCustomId[0]
                              : resolvedSearchParams.slotOfAvailabilityCustomId,
                            discountCode: Array.isArray(
                              resolvedSearchParams.discountCode,
                            )
                              ? resolvedSearchParams.discountCode[0]
                              : resolvedSearchParams.discountCode,
                            notes: Array.isArray(resolvedSearchParams.notes)
                              ? resolvedSearchParams.notes[0]
                              : resolvedSearchParams.notes,
                          })}
                          onPaymentSuccess={(response: {
                            razorpay_payment_id: string;
                          }) => {
                            toast({
                              title: "Payment Successful",
                              description: `Payment ID: ${response.razorpay_payment_id}`,
                            });
                            window.location.href = "/dashboard";
                          }}
                          onPaymentError={(error: { description: string }) => {
                            toast({
                              title: "Payment Failed",
                              description:
                                error.description ||
                                "An unknown error occurred",
                              variant: "destructive",
                            });
                          }}
                        />
                      ) : gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CONSULTATION",
                            planId: resolvedParams.planId,
                            paymentGateway: "STRIPE",
                            slotStartTimeInUTC: Array.isArray(
                              resolvedSearchParams.slotStartTimeInUTC,
                            )
                              ? resolvedSearchParams.slotStartTimeInUTC[0]
                              : resolvedSearchParams.slotStartTimeInUTC,
                            slotEndTimeInUTC: Array.isArray(
                              resolvedSearchParams.slotEndTimeInUTC,
                            )
                              ? resolvedSearchParams.slotEndTimeInUTC[0]
                              : resolvedSearchParams.slotEndTimeInUTC,
                            slotOfAvailabilityWeeklyId: Array.isArray(
                              resolvedSearchParams.slotOfAvailabilityWeeklyId,
                            )
                              ? resolvedSearchParams.slotOfAvailabilityWeeklyId[0]
                              : resolvedSearchParams.slotOfAvailabilityWeeklyId,
                            slotOfAvailabilityCustomId: Array.isArray(
                              resolvedSearchParams.slotOfAvailabilityCustomId,
                            )
                              ? resolvedSearchParams.slotOfAvailabilityCustomId[0]
                              : resolvedSearchParams.slotOfAvailabilityCustomId,
                            discountCode: Array.isArray(
                              resolvedSearchParams.discountCode,
                            )
                              ? resolvedSearchParams.discountCode[0]
                              : resolvedSearchParams.discountCode,
                            notes: Array.isArray(resolvedSearchParams.notes)
                              ? resolvedSearchParams.notes[0]
                              : resolvedSearchParams.notes,
                          })}
                          onPaymentSuccess={(response: any) => {
                            toast({
                              title: "Payment Successful",
                              description:
                                response.message ||
                                "Payment completed successfully",
                            });
                            window.location.href = "/dashboard";
                          }}
                          onPaymentError={(error: any) => {
                            toast({
                              title: "Payment Failed",
                              description:
                                error.message ||
                                error.description ||
                                "An unknown error occurred",
                              variant: "destructive",
                            });
                          }}
                        />
                      ) : null}
                      {/* Mock Payment Button */}
                      <Button
                        variant="secondary"
                        onClick={() => handleCheckout(gateway.gateway, true)}
                        disabled={isCheckoutProcessing}
                      >
                        {isCheckoutProcessing &&
                        processingGateway ===
                          `${gateway.gateway}-mock` ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                            Processing...
                          </>
                        ) : (
                          `Mock Pay (${gateway.name})`
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" disabled>
                      {/* TODO: Implement {gateway.name} integration */}
                      Coming Soon
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
