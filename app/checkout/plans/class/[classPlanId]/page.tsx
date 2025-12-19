"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { fetchReviews } from "@/lib/user";
import { searchParamsSchema, createCheckoutData } from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";
import { CreditCard as CreditCardIcon } from "lucide-react";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import RazorpayCheckout from "../../../components/RazorpayCheckout";
import StripeCheckout from "../../../components/StripeCheckout";
import {
  createHandleApiError,
  createHandleCheckoutSuccess,
  createRazorpayCheckoutHandlers,
  createStripeCheckoutHandlers,
  handleUnifiedCheckout,
} from "../../utils";
import {
  calculatePricing,
  formatCurrency,
  formatPercentage,
} from "../../math";

import type {
  Appointment,
  ClassContent,
  ClassPlan,
  ConsultantProfile,
  ConsultantReview,
  Domain,
  Class as PrismaClass,
  Tag as PrismaTag,
  Topic as PrismaTopic,
  SlotOfAppointment,
  SubDomain,
  User,
} from "@prisma/client";

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

  const handleApiError = createHandleApiError(toast);
  const handleCheckoutSuccess = createHandleCheckoutSuccess(toast, "CLASS");
  const stripeHandlers = createStripeCheckoutHandlers(toast);
  const razorpayHandlers = createRazorpayCheckoutHandlers(toast);

  const handleCheckout = useCallback(
    async (gateway: PaymentGateway, isMockPayment: boolean = false) => {
      if (isCheckoutProcessing) {
        return;
      }

      try {
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-${isMockPayment ? "mock" : "real"}`);

        const searchParamsValidation =
          searchParamsSchema.safeParse(resolvedSearchParams);
        if (!searchParamsValidation.success) {
          throw new Error("Invalid class parameters");
        }

        if (!planData?.data?.id) {
          throw new Error("Class plan not found");
        }

        // Find the first SCHEDULED or IN_PROGRESS class instance
        const availableClass = planData.data.classes?.find(
          (c) => c.status === "SCHEDULED" || c.status === "IN_PROGRESS",
        );

        if (!availableClass?.id) {
          throw new Error(
            "No available class sessions. All sessions may be full, cancelled, or completed.",
          );
        }

        const firstClassId = availableClass.id;

        const checkoutData = createCheckoutData({
          appointmentType: "CLASS",
          planId: planData.data.id,
          eventId: firstClassId,
          discountCode: searchParamsValidation.data.discountCode,
          paymentGateway: gateway,
        });

        await handleUnifiedCheckout(
          checkoutData,
          gateway,
          handleApiError,
          handleCheckoutSuccess,
          isMockPayment,
        );
      } catch (error) {
        console.error("Checkout error:", error);
        if (error instanceof Error) {
          // Provide more informative error messages based on the error type
          let errorTitle = "Unable to Complete Enrollment";
          let errorDescription = error.message;

          if (error.message.includes("Invalid class parameters")) {
            errorTitle = "Enrollment Link Error";
            errorDescription =
              "The enrollment information is incomplete. Please go back to the class page and click 'Enroll Now' again to ensure all required information is included.";
          } else if (error.message.includes("Class plan not found")) {
            errorTitle = "Class Not Found";
            errorDescription =
              "This class could not be found or may no longer be available. Please go back and select a different class, or contact support if you believe this is an error.";
          } else if (
            error.message.includes("network") ||
            error.message.includes("fetch")
          ) {
            errorTitle = "Connection Error";
            errorDescription =
              "Unable to connect to the server. Please check your internet connection and try again.";
          } else {
            errorDescription = `${error.message}. Please try again or contact support if the problem persists.`;
          }

          toast({
            title: errorTitle,
            description: errorDescription,
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
          throw new Error("Consultant details not found");
        }

        setPlanData(data);

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

  // Calculate pricing using the proper math functions
  // NOTE: This must be before early returns to maintain consistent hook order
  const pricing = useMemo(() => {
    const basePrice = planData?.data?.price || 0;
    // TODO: Look up actual discount from discountCode via API
    return calculatePricing(basePrice, {
      discountPercent: 0, // Will be updated when discount code is applied
    });
  }, [planData?.data?.price]);

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
  const currency = planDetails?.priceCurrency || "INR";
  const nextClassSession =
    planDetails?.classes?.[0]?.appointments?.[0]?.slotsOfAppointment?.[0];

  if (!planData || !planDetails || !consultantDetails || !userDetails) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>Essential class data is missing. Please try again later.</p>
      </div>
    );
  }

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
            <div className="font-semibold">Class</div>
            <div className="text-sm text-muted-foreground">
              {planDetails?.title || "Online Class"}
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Class Details</div>
          <div className="grid gap-2">
            {nextClassSession && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">First Session</div>
                  <div>
                    {new Date(nextClassSession.startsAt).toLocaleDateString(
                      undefined,
                      {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-muted-foreground">Time</div>
                  <div>
                    {new Date(nextClassSession.startsAt).toLocaleTimeString()} -{" "}
                    {new Date(nextClassSession.endsAt).toLocaleTimeString()} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Duration</div>
              <div>
                {planDetails?.durationInMonths} month
                {planDetails?.durationInMonths !== 1 ? "s" : ""} (
                {planDetails?.totalSessions || planDetails?.durationInMonths * 4}{" "}
                sessions)
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Sessions per Week</div>
              <div>{planDetails?.meetingsPerWeek || 2}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Max Participants</div>
              <div>{planDetails?.maxParticipants || "Unlimited"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Language</div>
              <div>{planDetails?.language || "English"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Level</div>
              <div>{planDetails?.level || "All Levels"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Prerequisites</div>
              <div>{planDetails?.prerequisites || "None"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Material Provided</div>
              <div>{planDetails?.materialProvided || "None"}</div>
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
                <div className="font-medium">CLASS15</div>
                <div className="text-sm text-muted-foreground">
                  Get 15% off your class enrollment
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
      <div className="flex flex-col gap-8 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Class Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Enrollment Fee</div>
                <div>{formatCurrency(planDetails?.price || 0, currency)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">Includes</span>
                </div>
                <div className="font-semibold">
                  <ul className="list-disc">
                    <li>
                      {planDetails?.totalSessions ||
                        (planDetails?.meetingsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      total sessions (
                      {planDetails?.totalHours ||
                        (planDetails?.meetingsPerWeek || 2) *
                          (planDetails?.durationInMonths || 1) *
                          4}{" "}
                      hours)
                    </li>
                    <li>{planDetails?.meetingsPerWeek || 2} sessions per week</li>
                    <li>Course materials</li>
                    <li>Certificate of completion</li>
                  </ul>
                </div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>{formatCurrency(pricing.subtotal, currency)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax ({formatPercentage(pricing.taxRate)})</div>
                <div>{formatCurrency(pricing.taxAmount, currency)}</div>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600">
                  <div>
                    Discount{" "}
                    {pricing.discountPercent > 0 &&
                      `(${formatPercentage(pricing.discountPercent)})`}
                  </div>
                  <div>-{formatCurrency(pricing.discountAmount, currency)}</div>
                </div>
              )}
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Total</div>
                <div>{formatCurrency(pricing.total, currency)}</div>
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
                      {gateway.gateway === "RAZORPAY" ? (
                        <RazorpayCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: planDetails.classes[0]?.id,
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
                      ) : gateway.gateway === "STRIPE" ? (
                        <StripeCheckout
                          checkoutData={createCheckoutData({
                            appointmentType: "CLASS",
                            planId: planDetails.id,
                            eventId: planDetails.classes[0]?.id,
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
                    </div>
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
    </>
  );
}
