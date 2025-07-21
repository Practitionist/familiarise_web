import { NextResponse } from "next/server";
import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import { Prisma } from "@prisma/client";

// Type for weekly availability slots
type TWeeklyAvailability = Prisma.SlotOfAvailabilityWeeklyGetPayload<{
  include: {
    consultantProfile: {
      select: {
        id: true;
        user: {
          select: {
            name: true;
            email: true;
          };
        };
      };
    };
  };
}>;

// Type for custom availability slots
type TCustomAvailability = Prisma.SlotOfAvailabilityCustomGetPayload<{
  include: {
    consultantProfile: {
      select: {
        id: true;
        user: {
          select: {
            name: true;
            email: true;
          };
        };
      };
    };
  };
}>;

interface RequestsData {
  consultations: TConsultation[];
  subscriptions: TSubscription[];
  weeklyAvailability: TWeeklyAvailability[];
  customAvailability: TCustomAvailability[];
  appointments: TAppointment[];
  consultant: TConsultantProfile | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> }
) {
  try {
    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 }
      );
    }

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Fetch all requests data in parallel
    const [
      consultationsRes,
      subscriptionsRes,
      weeklyAvailabilityRes,
      customAvailabilityRes,
      appointmentsRes,
      consultantRes,
    ] = await Promise.all([
      fetch(
        `${baseUrl}/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`
      ),
      fetch(
        `${baseUrl}/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`
      ),
      fetch(
        `${baseUrl}/api/slots/availability/weekly?consultantProfileId=${consultantId}`
      ),
      fetch(
        `${baseUrl}/api/slots/availability/custom?consultantProfileId=${consultantId}`
      ),
      fetch(
        `${baseUrl}/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`
      ),
      fetch(`${baseUrl}/api/user/consultants/${consultantId}`),
    ]);

    // Check for errors in any of the responses
    const responses = [
      { name: "consultations", response: consultationsRes },
      { name: "subscriptions", response: subscriptionsRes },
      { name: "weeklyAvailability", response: weeklyAvailabilityRes },
      { name: "customAvailability", response: customAvailabilityRes },
      { name: "appointments", response: appointmentsRes },
      { name: "consultant", response: consultantRes },
    ];

    for (const { name, response } of responses) {
      if (!response.ok) {
        console.error(`Failed to fetch ${name}:`, response.statusText);
        return NextResponse.json(
          { error: `Failed to fetch ${name} data` },
          { status: response.status }
        );
      }
    }

    // Parse all responses with proper typing
    const [
      consultationsData,
      subscriptionsData,
      weeklyAvailabilityData,
      customAvailabilityData,
      appointmentsData,
      consultantData,
    ] = await Promise.all([
      consultationsRes.json() as Promise<{ data: TConsultation[] }>,
      subscriptionsRes.json() as Promise<{ data: TSubscription[] }>,
      weeklyAvailabilityRes.json() as Promise<{ data: TWeeklyAvailability[] }>,
      customAvailabilityRes.json() as Promise<{ data: TCustomAvailability[] }>,
      appointmentsRes.json() as Promise<{ data: TAppointment[] }>,
      consultantRes.json() as Promise<{ data: TConsultantProfile }>,
    ]);

    const requestsData: RequestsData = {
      consultations: consultationsData.data || [],
      subscriptions: subscriptionsData.data || [],
      weeklyAvailability: weeklyAvailabilityData.data || [],
      customAvailability: customAvailabilityData.data || [],
      appointments: appointmentsData.data || [],
      consultant: consultantData.data || null,
    };

    return NextResponse.json({
      data: requestsData,
      success: true,
    });
  } catch (error: unknown) {
    console.error("Error fetching requests data:", error);
    return NextResponse.json(
      { error: "Failed to fetch requests data" },
      { status: 500 }
    );
  }
}
