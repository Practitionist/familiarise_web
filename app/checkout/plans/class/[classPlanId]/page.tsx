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
  classSearchParamsSchema,
  createCheckoutData,
} from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";
import { loadStripe } from "@stripe/stripe-js";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useCallback, useEffect, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createHandleCheckoutSuccess,
  handleProductionCheckout,
  paymentGateways,
  createStripeCheckoutHandlers,
  createRazorpayCheckoutHandlers,
} from "../../utils";

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
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
  const { toast } = useToast();

  // Create utility functions using the toast instance
  const handleApiError = createHandleApiError(toast);
  const handleCheckoutSuccess = createHandleCheckoutSuccess(toast, "CLASS");
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

  const handleCheckout = useCallback(
    async (gateway: PaymentGateway, isMockPayment: boolean = false) => {
      // Prevent double-clicks and multiple simultaneous requests
      if (isCheckoutProcessing) {
        return;
      }

      try {
        // Set loading state
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        // Validate search params using the shared schema
        const searchParamsValidation =
          classSearchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          throw new Error("Invalid class parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Class plan not found");
        }

        // Create checkout data using the shared utility
        const checkoutData = createCheckoutData({
          appointmentType: "CLASS",
          planId: planData.data.id,
          eventId: resolvedParams.classPlanId,
          discountCode: searchParamsValidation.data.discountCode,
          paymentGateway: gateway,
        });

        // Handle production checkout flow using the utility
        await handleProductionCheckout(
          checkoutData,
          gateway,
          handleApiError,
          handleCheckoutSuccess,
          isMockPayment,
        );
      } catch (error) {
        console.error("Checkout error:", error);
        if (error instanceof Error) {
          toast({
            title: "Checkout Failed",
            description: error.message,
            variant: "destructive",
          });
        }
      } finally {
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      isCheckoutProcessing,
      resolvedSearchParams,
      planData?.data?.id,
      resolvedParams.classPlanId,
      handleApiError,
      handleCheckoutSuccess,
      toast,
    ],
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
                  <Card
                    key={gateway.gateway}
                    className="p-4 hover:shadow-md transition-shadow cursor-pointer"
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <CreditCardIcon className="h-4 w-4" />
                        {gateway.name}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <p className="text-xs text-gray-600 mb-4">
                        {gateway.description}
                      </p>
                      <div className="flex justify-center gap-2">
                        {gateway.isActive ? (
                          <>
                            {gateway.gateway === "STRIPE" ? (
                              <StripeCheckout
                                checkoutData={createCheckoutData({
                                  appointmentType: "CLASS",
                                  planId: planDetails.id,
                                  eventId: planDetails.classes[0].id,
                                  paymentGateway: "STRIPE",
                                  discountCode: Array.isArray(
                                    resolvedSearchParams.discountCode,
                                  )
                                    ? resolvedSearchParams.discountCode[0]
                                    : resolvedSearchParams.discountCode,
                                })}
                                onPaymentSuccess={stripeHandlers.onPaymentSuccess}
                                onPaymentError={stripeHandlers.onPaymentError}
                              />
                            ) : gateway.gateway === "RAZORPAY" ? (
                              <RazorpayCheckout
                                checkoutData={createCheckoutData({
                                  appointmentType: "CLASS",
                                  planId: planDetails.id,
                                  eventId: planDetails.classes[0].id,
                                  paymentGateway: "RAZORPAY",
                                  discountCode: Array.isArray(
                                    resolvedSearchParams.discountCode,
                                  )
                                    ? resolvedSearchParams.discountCode[0]
                                    : resolvedSearchParams.discountCode,
                                })}
                                onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                                onPaymentError={razorpayHandlers.onPaymentError}
                              />
                            ) : null}
                            <Button
                              variant="secondary"
                              onClick={() => handleCheckout(gateway.gateway, true)}
                              disabled={isCheckoutProcessing}
                            >
                              {isCheckoutProcessing &&
                              processingGateway === `${gateway.gateway}-mock` ? (
                                <>
                                  <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                                  Processing...
                                </>
                              ) : (
                                `Mock Pay (${gateway.name})`
                              )}
                            </Button>
                          </>
                        ) : (
                          <Button variant="outline" disabled>
                            Coming Soon
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
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
