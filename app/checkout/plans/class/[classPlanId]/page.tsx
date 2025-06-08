"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fetchReviews } from "@/lib/user";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useEffect, useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { loadStripe } from "@stripe/stripe-js";

import type {
  ClassPlan,
  ConsultantProfile,
  User,
  Domain,
  SubDomain,
  Tag as PrismaTag,
  ClassContent,
  Topic as PrismaTopic,
  Class as PrismaClass,
  Appointment,
  SlotOfAppointment,
  ConsultantReview,
} from "@prisma/client";

// Define a type for the fetched ClassPlan data, similar to ClassPlanDetailsData but tailored for checkout if needed
// For now, let's assume the API returns a structure compatible with a detailed ClassPlan
export type CheckoutClassPlanData = ClassPlan & {
  consultantProfile:
    | (ConsultantProfile & {
        user: User;
        domain: Domain | null;
        subDomains: SubDomain[];
        tags: PrismaTag[];
      })
    | null;
  classes: (PrismaClass & {
    appointments: (Appointment & {
      slotsOfAppointment: SlotOfAppointment[];
    })[];
  })[];
  topics: PrismaTopic[];
  classContents: ClassContent[];
  type: "class";
  imageUrl: string;
};

type PlanResponse = {
  data: CheckoutClassPlanData;
};

const classSchema = z.object({
  discountCode: z.string().optional(),
});

type PageProps = {
  params: Promise<{ classPlanId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  // Next.js 15 Synchronous params and searchParams
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);

  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_reviews, _setReviews] = useState<ConsultantReview[]>([]);
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
        title: "Registration Unavailable",
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
  const makeCheckoutRequest = async (parsedParams: any, gateway: string) => {
    if (!planData?.data?.id) {
      throw new Error("Class plan not found");
    }

    // Get the first available class instance from the plan
    const availableClass = planData.data.classes?.[0];
    if (!availableClass) {
      throw new Error("No class instances available for this plan");
    }

    return fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appointmentType: "CLASS",
        planId: planData.data.id,
        eventId: availableClass.id,
        discountCode: parsedParams.data.discountCode,
        paymentGateway: gateway,
      }),
    });
  };

  // Common success handling logic
  const handleCheckoutSuccess = (data: any, isDevMode: boolean = false) => {
    if (isDevMode) {
      // Development mode - direct registration success
      toast({
        title: "✅ Class Registration Successful!",
        description: data.skipPayment
          ? "You're registered for the class. Check your dashboard for details."
          : "Payment processed successfully. You're registered for the class.",
        variant: "default",
      });

      // Redirect after a short delay
      setTimeout(() => {
        window.location.href = "/dashboard/consultee";
      }, 2000);
    } else {
      // Production mode - payment initiated success
      toast({
        title: "🚀 Payment Initiated!",
        description:
          "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        variant: "default",
      });
    }
  };

  // Development workflow - direct registration
  const handleDevCheckout = async (parsedParams: any, gateway: string) => {
    const response = await makeCheckoutRequest(parsedParams, gateway);

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(errorData);
      throw new Error(errorData.error || "Registration failed");
    }

    const data = await response.json();
    handleCheckoutSuccess(data, true);
  };

  // Production workflow - payment gateway processing
  const handleProdCheckout = async (
    parsedParams: any,
    gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW",
  ) => {
    const response = await makeCheckoutRequest(parsedParams, gateway);

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(errorData);
      throw new Error(errorData.error || "Checkout failed");
    }

    const data = await response.json();

    // Show success toast before redirecting
    handleCheckoutSuccess(data, false);

    // Small delay to let user see the toast before redirect
    setTimeout(async () => {
      // Handle gateway-specific responses
      switch (gateway) {
        case "STRIPE": {
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
          window.location.href = `/checkout/razorpay?order_id=${data.orderId}`;
          break;
        }
        case "LEMON_SQUEEZY":
        case "XFLOW": {
          window.location.href = data.checkoutUrl;
          break;
        }
      }
    }, 1000);
  };

  const handleCheckout = useCallback(
    async (gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW") => {
      try {
        // Validate params first
        const parsedParams = classSchema.safeParse(resolvedSearchParams);
        if (!parsedParams.success) {
          throw new Error("Invalid class parameters");
        }

        // Route to appropriate workflow based on environment
        const isDevelopment =
          process.env.NODE_ENV === "development" ||
          process.env.NODE_ENV === "test";

        if (isDevelopment) {
          await handleDevCheckout(parsedParams, gateway);
        } else {
          await handleProdCheckout(parsedParams, gateway);
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
      }
    },
    [resolvedParams, resolvedSearchParams, planData, toast],
  );

  useEffect(() => {
    async function fetchPlanData() {
      setIsLoading(true);
      try {
        const endpoint = `/api/plans/classes/${resolvedParams.classPlanId}`;

        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.data?.consultantProfile?.user) {
          // Adjusted path for direct ClassPlan data
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
  }, [resolvedParams.classPlanId]);

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

  if (!planData) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>No plan data available.</p>
      </div>
    );
  }

  const { data: planDetails } = planData; // Renamed for clarity

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
                      src={
                        planDetails.consultantProfile?.user.image ?? undefined
                      }
                      alt={
                        planDetails.consultantProfile?.user.name ?? "Consultant"
                      }
                    />
                    <AvatarFallback>
                      {planDetails.consultantProfile?.user.name
                        ?.split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-gray-800">
                      {planDetails.consultantProfile?.user.name}
                    </p>
                    <p className="text-sm text-gray-500">
                      {planDetails.consultantProfile?.user.email}
                    </p>
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
                  <div className="flex justify-between">
                    <span>Discount:</span>
                    <span className="text-green-600">-₹0.00</span>
                  </div>
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
                      {/* You can add icons here if you have them */}
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
