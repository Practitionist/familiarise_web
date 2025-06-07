"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";

import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/components/ui/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

import type {
  WebinarPlan,
  ConsultantProfile,
  User,
  Domain,
  SubDomain,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  Webinar as PrismaWebinar,
  Appointment,
  SlotOfAppointment,
  ConsultantReview,
} from "@prisma/client";

// Define a type for the fetched WebinarPlan data
export type CheckoutWebinarPlanData = WebinarPlan & {
  consultantProfile:
    | (ConsultantProfile & {
        user: User;
        domain: Domain | null;
        subDomains: SubDomain[];
        tags: PrismaTag[];
      })
    | null;
  webinars: (PrismaWebinar & {
    appointment:
      | (Appointment & {
          slotsOfAppointment: SlotOfAppointment[];
        })
      | null; // appointment can be null for a webinar instance
  })[];
  topics: PrismaTopic[];
  type: "webinar";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutWebinarPlanData;
};

const webinarSchema = z.object({
  discountCode: z.string().optional(),
});

type PageProps = {
  params: Promise<{ webinarPlanId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function WebinarCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams); // Added to match class checkout page structure

  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
  const { toast } = useToast();

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        // Validate params first
        const parsedParams = webinarSchema.safeParse(resolvedSearchParams);
        if (!parsedParams.success) {
          throw new Error("Invalid webinar parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Webinar plan not found");
        }

        // Get the first available webinar instance from the plan
        const availableWebinar = planData.data.webinars?.[0];
        if (!availableWebinar) {
          throw new Error("No webinar instances available for this plan");
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
              planId: planData.data.id,
              eventId: availableWebinar.id,
              discountCode: parsedParams.data.discountCode,
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
            appointmentType: "WEBINAR",
            planId: planData.data.id,
            eventId: availableWebinar.id,
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

          case "RAZORPAY": {
            // Redirect to Razorpay checkout
            window.location.href = `/checkout/razorpay?order_id=${data.orderId}`;
            break;
          }
          case "LEMON_SQUEEZY":
          case "XFLOW": {
            // Direct URL redirect
            window.location.href = data.checkoutUrl;
            break;
          }
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
    [resolvedParams.webinarPlanId, resolvedSearchParams, planData, toast],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/plans/webinars/${resolvedParams.webinarPlanId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.consultantProfile?.user) {
          // Adjusted path for direct WebinarPlan data
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

        // Fetch reviews for the consultant
        const reviewsData = await fetchReviews(
          data.data.consultantProfile?.id ?? "",
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
  }, [resolvedParams.webinarPlanId]);

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

  const planDetails = planData?.data;
  const consultantDetails = planDetails?.consultantProfile;
  const userDetails = consultantDetails?.user;
  // For checkout, we might not need 'nextSession' as prominently, or it might be derived differently.
  // Let's assume the planDetails itself is the primary subject for checkout.
  // const nextSession = planDetails?.webinars?.[0]?.appointment?.slotsOfAppointment?.[0];

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    // nextSession might not be strictly required for checkout page display
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Essential webinar data is missing. Please try again later.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <Card className="shadow-lg">
          <CardHeader className="bg-gray-50 p-6">
            <CardTitle className="text-2xl font-bold text-gray-800 flex items-center">
              <CreditCardIcon className="mr-3 h-8 w-8 text-blue-600" />
              Checkout
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <h2 className="text-xl font-semibold text-gray-700 mb-3">
                  {planDetails.title}
                </h2>
                <div className="flex items-center mb-4">
                  <Avatar className="h-12 w-12 mr-3">
                    <AvatarImage
                      src={userDetails.image ?? undefined}
                      alt={userDetails.name ?? "Consultant"}
                    />
                    <AvatarFallback>
                      {userDetails.name
                        ?.split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-gray-800">
                      {userDetails.name}
                    </p>
                    <p className="text-sm text-gray-500">{userDetails.email}</p>
                  </div>
                </div>
                <p className="text-gray-600 text-sm mb-4">
                  {planDetails.description}
                </p>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-700 mb-3">
                  Order Summary
                </h3>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex justify-between">
                    <span>Original Price:</span>
                    <span>₹{planDetails.price}</span>
                  </div>
                  {/* Discount logic can be added here if applicable */}
                  <Separator className="my-2" />
                  <div className="flex justify-between font-bold text-lg text-gray-800">
                    <span>Total:</span>
                    <span>₹{planDetails.price}</span>
                  </div>
                </div>
                <div className="mt-6">
                  <label
                    htmlFor="discountCode"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Discount Code (Optional)
                  </label>
                  <Input
                    id="discountCode"
                    name="discountCode"
                    type="text"
                    placeholder="Enter discount code"
                    className="w-full"
                    defaultValue={
                      resolvedSearchParams.discountCode as string | undefined
                    }
                  />
                </div>
              </div>
            </div>

            <Separator className="my-8" />

            <div>
              <h3 className="text-xl font-semibold text-gray-700 mb-6 text-center">
                Select Payment Method
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"].map(
                  (gateway) => (
                    <Button
                      key={gateway}
                      variant="outline"
                      className="w-full h-20 text-lg flex flex-col items-center justify-center hover:bg-blue-50 transition-colors duration-150"
                      onClick={() =>
                        handleCheckout(
                          gateway as
                            | "STRIPE"
                            | "RAZORPAY"
                            | "LEMON_SQUEEZY"
                            | "XFLOW",
                        )
                      }
                    >
                      {gateway.charAt(0).toUpperCase() +
                        gateway.slice(1).toLowerCase()}
                    </Button>
                  ),
                )}
              </div>
            </div>

            <div className="mt-10 text-center">
              <p className="text-xs text-gray-500">
                By clicking a payment method, you agree to our Terms of Service
                and Privacy Policy.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
