"use client"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { CheckIcon } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { JSX, SVGProps, useEffect, useState } from "react"
import { z } from "zod"
import { ConsultantProfile, ConsultantReview, User } from "@prisma/client"
import { fetchConsultantDetails, fetchReviews, fetchUserDetails } from "@/hooks/useUserData"
import { motion } from "framer-motion"

const eventSchemas = {
  consultation: z.object({
    consultationPlanId: z.string(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    discountCode: z.string().optional(),
  }).refine(
    data => data.slotOfAvailabilityWeeklyId || data.slotOfAvailabilityCustomId,
    {
      message: "Either slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
      path: ["slotOfAvailabilityWeeklyId", "slotOfAvailabilityCustomId"],
    }
  ),
  subscription: z.object({
    subscriptionPlanId: z.string(),
    discountCode: z.string().optional(),
  }),
  webinar: z.object({
    webinarPlanId: z.string(),
    webinarId: z.string(),
    discountCode: z.string().optional(),
  }),
  class: z.object({
    classPlanId: z.string(),
    classId: z.string(),
    discountCode: z.string().optional(),
  }),
};

const apiEndpoints = {
  // POST booked
  consultation: (planId: string) => `/api/plans/consultations/${planId}`,
  subscription: (planId: string) => `/api/plans/subscriptions/${planId}`,
  
  // PRE booked
  webinar: (webinarId: string) => `/api/events/webinars/${webinarId}`,
  class: (classId: string) => `/api/events/classes/${classId}`,
};

export default function CheckoutPage({ params }: { params: { appointmentType: string } }) {
  const searchParams = useSearchParams();
  const { appointmentType } = params;
  const [eventData, setEventData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [consultantId, setConsultantId] = useState<string | null>(null);
  
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [consultantDetails, setConsultantDetails] = useState<ConsultantProfile | null>(null);
  const [reviews, setReviews] = useState<ConsultantReview[]>([]);


  useEffect(() => {
    async function fetchEventData() {
      setIsLoading(true);
      try {
        // Get the schema for the current appointment type
        const schema = eventSchemas[appointmentType as keyof typeof eventSchemas];
        if (!schema) {
          throw new Error("Invalid appointment type");
        }

        // Parse and validate the search params using the schema
        const parsedParams = schema.safeParse(Object.fromEntries(searchParams));

        if (!parsedParams.success) {
          const issues = parsedParams.error.issues;
          const missingFields = issues.map(issue => issue.path[0]).join(', ');
          throw new Error(`Missing required fields: ${missingFields}`);
        }

        // Construct the API endpoint based on the appointment type and params
        const endpoint = apiEndpoints[appointmentType as keyof typeof apiEndpoints](
          // Use the appropriate ID based on the appointment type, fallback to planId or empty string
          parsedParams.data[`${appointmentType}Id` as keyof typeof parsedParams.data] || 
          (parsedParams.data as { planId?: string }).planId || 
          ''
        );

        // Fetch data from the API
        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Parse the response JSON
        const data = await response.json();

        // Extract consultant ID from the response data
        let extractedConsultantId;
        if (appointmentType === 'consultation' || appointmentType === 'subscription') {
          extractedConsultantId = data.data.consultantProfileId;
        } else if (appointmentType === 'webinar' || appointmentType === 'class') {
          extractedConsultantId = data.data.consultantProfile?.id;
        }

        if (!extractedConsultantId) {
          throw new Error("Consultant ID not found in the response");
        }

        // Update the state with the fetched data and consultant ID
        setEventData(data);
        setConsultantId(extractedConsultantId);

        const consultantData = await fetchConsultantDetails(extractedConsultantId);
        const userData = await fetchUserDetails(consultantData.userId);
        const reviewsData = await fetchReviews(extractedConsultantId);
        
        setConsultantDetails(consultantData);
        setUserDetails(userData);
        setReviews(reviewsData);
      } catch (error) {
        console.error("Error fetching event data:", error);
        let errorMessage = 'An unexpected error occurred. Please try again.';
        
        if (error instanceof Error) {
          if (error.message.includes('Missing required fields')) {
            errorMessage = error.message + '. Please ensure you have provided all necessary information.';
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
  }, [appointmentType, searchParams]);

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
        <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4" role="alert">
          <p className="font-bold">Oops! Something went wrong</p>
          <p>{error}</p>
          <p className="mt-2">Please check your selection and try again. If the problem persists, contact support.</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="grid min-h-screen w-full overflow-hidden lg:grid-cols-[60%_40%]"
    >
      <div className="flex flex-col gap-8 border-r bg-muted/40 p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Avatar className="w-12 h-12 border">
              <AvatarImage src={userDetails?.image || "/placeholder-user.jpg"} alt={userDetails?.name || "Consultant"} />
              <AvatarFallback>{userDetails?.name ? userDetails.name.charAt(0) : "C"}</AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">{userDetails?.name || "Consultant Name"}</div>
              <div className="text-sm text-muted-foreground">{consultantDetails?.specialization || "Consultant"}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold">{appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1)}</div>
            <div className="text-sm text-muted-foreground">Date and time to be scheduled</div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-2">
          <div className="font-semibold">Consultant Details</div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Specialization</div>
              <div>{consultantDetails?.specialization || "Not specified"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Experience</div>
              <div>{consultantDetails?.experience || "Not specified"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Location</div>
              <div>{consultantDetails?.location || "Not specified"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Description</div>
              <div className="text-right">
                {consultantDetails?.description || "No description available"}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Tags</div>
              <div className="flex gap-2">
                {consultantDetails?.tags.map((tag, index) => (
                  <Badge key={index} variant="outline">{tag}</Badge>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Domain</div>
              <div>{consultantDetails?.domain || "Not specified"}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Sub-Domains</div>
              <div className="flex gap-2">
                {consultantDetails?.subDomains.map((subDomain, index) => (
                  <Badge key={index} variant="outline">{subDomain}</Badge>
                ))}
              </div>
            </div>
          </div>
        </div>
        <Separator className="bg-gray-300" />
        <div className="grid gap-4">
          <div className="font-semibold">Discount Codes</div>
          <div className="flex items-center gap-2">
            <Input type="text" placeholder="Enter discount code" className="flex-1" />
            <Button variant="outline">Apply</Button>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">SUMMERSALE10</div>
                <div className="text-sm text-muted-foreground">Get 10% off your purchase during the summer sale</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">10% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">NEWCUSTOMER15</div>
                <div className="text-sm text-muted-foreground">New customers get 15% off their first order</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">15% off</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">FREESHIP</div>
                <div className="text-sm text-muted-foreground">Enjoy free shipping on your order</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">Free Shipping</div>
                <Button variant="outline" size="sm">
                  Apply
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">HOLIDAY20</div>
                <div className="text-sm text-muted-foreground">Get 20% off during the holiday season</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-muted-foreground">20% off</div>
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
            <CardTitle>Pricing</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {/* Pricing details should be dynamically populated based on the selected plan */}
            {/* This is a placeholder and should be updated with actual data from eventData */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>1 hour</div>
                <div>$100</div>
              </div>
              <div className="flex items-center justify-between">
                <div>2 hours</div>
                <div>$200</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <span className="font-semibold">3 hours</span>
                  <CheckIcon className="w-4 h-4 mr-2" />
                </div>
                <div className="font-semibold">$300</div>
              </div>
            </div>
            <Separator className="bg-gray-300" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>$300</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Tax (10%)</div>
                <div>$30</div>
              </div>
              <div className="flex items-center justify-between">
                <div>Discount (10%)</div>
                <div>-$30</div>
              </div>
              <Separator className="bg-gray-300" />
              <div className="flex items-center justify-between font-semibold">
                <div>Net Amount</div>
                <div>$300</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <div className="font-semibold">Payment</div>
            <div className="text-muted-foreground">Select your preferred payment method</div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Stripe</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <CreditCardIcon className="w-8 h-8" />
                  <div>
                    <div className="font-semibold">Credit/Debit Card</div>
                    <div className="text-sm text-muted-foreground">Securely pay with your card</div>
                  </div>
                </div>
                <Button variant="outline">Pay with Stripe</Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Razorpay</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <CreditCardIcon className="w-8 h-8" />
                  <div>
                    <div className="font-semibold">Credit/Debit Card</div>
                    <div className="text-sm text-muted-foreground">Securely pay with your card</div>
                  </div>
                </div>
                <Button variant="outline">Pay with Razorpay</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </motion.div>
  )
}

function CreditCardIcon(props: JSX.IntrinsicAttributes & SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </svg>
  )
}
