import {
  getActualNextSlotTime,
  getActualUpcomingSlots,
  getActualMonthlyEvents,
  formatTimeUntil,
  getActualSlots,
} from "./actual-schedule";
import { EventWithType } from "../utils";
import {
  ConsultationMode,
  UserRole,
  ScheduleType,
  PlanEmailSupport,
} from "@prisma/client";

describe("Schedule Data Consistency Tests", () => {
  const consulteeIds = ["73318747-3425-4bb6-bba7-c3d6a6798441"];
  const now = new Date("2024-12-28T00:00:00Z");

  // Mock user data
  const mockUser = {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    phone: null,
    image: null,
    address: null,
    role: UserRole.CONSULTEE,
    onlineStatus: false,
    currentTimezone: null,
    onboardingCompleted: false,
    consultantProfileId: null,
    consulteeProfileId: null,
    staffProfileId: null,
    emailVerified: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockConsulteeProfile = {
    id: consulteeIds[0],
    userId: "user-1",
    user: mockUser,
    education: null,
    occupation: null,
    aboutMe: null,
    preferredCommunicationMethod: ConsultationMode.VIDEO,
    preferredLanguage: null,
    specialRequirements: null,
    interests: null,
    goals: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Mock consultant profile data
  const mockConsultantProfile = (name: string) => ({
    id: `consultant-${name.toLowerCase().replace(/\s+/g, "-")}`,
    userId: `consultant-user-${name.toLowerCase().replace(/\s+/g, "-")}`,
    user: {
      ...mockUser,
      name,
      onlineStatus: true,
      role: UserRole.CONSULTANT,
      onboardingCompleted: true,
    },
    rating: 4.5,
    description: "Experienced consultant",
    qualifications: "PhD in relevant field",
    specialization: "Career Development",
    experience: "10+ years",
    domainId: "domain-1",
    scheduleType: ScheduleType.WEEKLY,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Mock events based on HomeTab and Overview screenshots
  const mockEvents: EventWithType[] = [
    // Basic Subscription with Dean Steuber
    {
      id: "subscription-1",
      type: "Subscription",
      requestStatus: "REJECTED",
      subscriptionPlan: {
        id: "plan-1",
        title: "Basic Subscription",
        description: "Basic subscription plan",
        price: 9999, // in cents
        durationInMonths: 3,
        callsPerWeek: 1,
        videoMeetings: 4,
        emailSupport: PlanEmailSupport.GENERAL,
        language: "English",
        level: "Beginner",
        prerequisites: "None",
        materialProvided: "None",
        learningOutcomes: [],
        consultantProfile: mockConsultantProfile("Dean Steuber"),
        consultantProfileId: "consultant-dean-steuber",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      subscriptionPlanId: "plan-1",
      requestedBy: mockConsulteeProfile,
      requestedById: consulteeIds[0],
      tentativeSchedule: JSON.stringify([
        {
          startTime: "2024-12-30T13:00:00Z",
          endTime: "2024-12-30T15:00:00Z",
          timezone: "UTC",
        },
      ]),
      appointments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      endDate: new Date("2025-01-31T00:00:00Z"),
    },

    // Intermediate Class with Mr. Santos Murray (COMPLETED)
    {
      id: "class-1",
      type: "Class",
      status: "COMPLETED",
      classPlan: {
        id: "plan-2",
        title: "Intermediate Class",
        description: "Intermediate level class",
        price: 19999, // in cents
        certificateProvided: true,
        durationInMonths: 3,
        callsPerWeek: 1,
        videoMeetings: 4,
        emailSupport: PlanEmailSupport.GENERAL,
        maxParticipants: 10,
        language: "English",
        level: "Intermediate",
        prerequisites: "Basic knowledge required",
        materialProvided: "Course materials included",
        learningOutcomes: ["Skill 1", "Skill 2"],
        consultantProfile: mockConsultantProfile("Mr. Santos Murray"),
        consultantProfileId: "consultant-mr-santos-murray",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      classPlanId: "plan-2",
      tentativeSchedule: JSON.stringify([
        {
          startTime: "2024-12-18T15:00:00Z",
          endTime: "2024-12-18T17:00:00Z",
          timezone: "UTC",
        },
        {
          startTime: "2024-12-25T13:00:00Z",
          endTime: "2024-12-25T16:00:00Z",
          timezone: "UTC",
        },
        {
          startTime: "2025-01-01T12:00:00Z",
          endTime: "2025-01-01T13:00:00Z",
          timezone: "UTC",
        },
        {
          startTime: "2025-01-08T13:00:00Z",
          endTime: "2025-01-08T14:00:00Z",
          timezone: "UTC",
        },
      ]),
      appointment: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      endDate: new Date("2025-02-28T00:00:00Z"),
    },

    // Extended Consultation with Francis Daniel
    {
      id: "consultation-1",
      type: "Consultation",
      requestStatus: "REJECTED",
      consultationPlan: {
        id: "plan-3",
        title: "Extended Consultation",
        description: "Extended consultation session",
        durationInHours: 2,
        price: 14999, // in cents
        language: "English",
        level: "Beginner",
        prerequisites: "None",
        materialProvided: "None",
        learningOutcomes: [],
        consultantProfile: mockConsultantProfile("Francis Daniel"),
        consultantProfileId: "consultant-francis-daniel",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      consultationPlanId: "plan-3",
      requestedBy: mockConsulteeProfile,
      requestedById: consulteeIds[0],
      preferredDateTime: new Date("2024-12-28T03:30:00Z"),
      appointment: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe("UI Data Consistency", () => {
    it('should show correct "days away" count in both views', () => {
      const upcomingSlots = getActualUpcomingSlots(mockEvents);

      // Check Basic Subscription slots
      const subscriptionSlots = upcomingSlots.filter(
        ({ event }) =>
          event.type === "Subscription" &&
          event.subscriptionPlan.title === "Basic Subscription",
      );

      const expectedDays = [2]; // Only one slot in the test data
      subscriptionSlots.forEach(({ slotTime }, index) => {
        const diffInDays = Math.floor(
          (slotTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );
        expect(diffInDays).toBe(expectedDays[index]);
      });
    });

    it('should mark tentative schedules as "Subject to change"', () => {
      const slots = mockEvents.flatMap((event) => getActualSlots(event));

      // All subscription slots should be marked as tentative
      const subscriptionSlots = slots.filter((slot) =>
        mockEvents.some(
          (e) =>
            e.type === "Subscription" &&
            e.tentativeSchedule?.includes(slot.date.toISOString()),
        ),
      );
      subscriptionSlots.forEach((slot) => {
        expect(slot.isTentative).toBe(true);
      });

      // Completed class slots should not be tentative
      const completedClassSlots = slots.filter((slot) =>
        mockEvents.some(
          (e) =>
            e.type === "Class" &&
            e.status === "COMPLETED" &&
            e.tentativeSchedule?.includes(slot.date.toISOString()),
        ),
      );
      completedClassSlots.forEach((slot) => {
        expect(slot.isTentative).toBe(false);
      });
    });

    it("should show same events in upcoming slots and monthly view", () => {
      // Get all slots for January 2025
      const january2025 = new Date("2025-01-01T00:00:00Z");
      const monthlyEvents = getActualMonthlyEvents(mockEvents, january2025);

      // Get upcoming slots that fall in January 2025
      const upcomingSlots = getActualUpcomingSlots(mockEvents).filter(
        ({ slotTime }) =>
          slotTime.getMonth() === january2025.getMonth() &&
          slotTime.getFullYear() === january2025.getFullYear(),
      );

      // Each upcoming slot should be in monthly view
      upcomingSlots.forEach(({ event, slotTime }) => {
        const foundInMonthly = monthlyEvents.some(
          (monthly) =>
            monthly.event.id === event.id &&
            monthly.slots.some(
              (slot) => slot.date.getTime() === slotTime.getTime(),
            ),
        );
        expect(foundInMonthly).toBe(true);
      });

      // Each monthly slot should be in upcoming slots
      monthlyEvents.forEach((monthly) => {
        monthly.slots.forEach((monthlySlot) => {
          const foundInUpcoming = upcomingSlots.some(
            ({ slotTime }) => slotTime.getTime() === monthlySlot.date.getTime(),
          );
          expect(foundInUpcoming).toBe(true);
        });
      });
    });

    it("should maintain COMPLETED status for class events", () => {
      const classEvent = mockEvents.find(
        (e) =>
          e.type === "Class" &&
          e.classPlan.consultantProfile?.user?.name === "Mr. Santos Murray",
      );
      if (!classEvent || classEvent.type !== "Class") {
        throw new Error("Class event not found");
      }
      expect(classEvent.status).toBe("COMPLETED");
    });

    it("should maintain REJECTED status for subscription events", () => {
      const subscriptionEvent = mockEvents.find(
        (e) => e.type === "Subscription",
      );
      if (!subscriptionEvent || subscriptionEvent.type !== "Subscription") {
        throw new Error("Subscription event not found");
      }
      expect(subscriptionEvent.requestStatus).toBe("REJECTED");
    });

    it("should maintain REJECTED status for consultation events", () => {
      const consultationEvent = mockEvents.find(
        (e) => e.type === "Consultation",
      );
      if (!consultationEvent || consultationEvent.type !== "Consultation") {
        throw new Error("Consultation event not found");
      }
      expect(consultationEvent.requestStatus).toBe("REJECTED");
    });

    it("should show correct time slots for Intermediate Class", () => {
      const classEvent = mockEvents.find(
        (e) => e.type === "Class" && e.classPlan.title === "Intermediate Class",
      );
      if (!classEvent || classEvent.type !== "Class") {
        throw new Error("Class event not found");
      }

      const slots = getActualSlots(classEvent);
      expect(slots).toHaveLength(4);

      // Verify specific time slots from the UI
      expect(slots[0].date).toEqual(new Date("2024-12-18T15:00:00Z"));
      expect(slots[1].date).toEqual(new Date("2024-12-25T13:00:00Z"));
      expect(slots[2].date).toEqual(new Date("2025-01-01T12:00:00Z"));
      expect(slots[3].date).toEqual(new Date("2025-01-08T13:00:00Z"));
    });

    it("should handle rejected consultations correctly", () => {
      const consultation = mockEvents.find((e) => e.type === "Consultation");
      if (!consultation || consultation.type !== "Consultation") {
        throw new Error("Consultation event not found");
      }

      expect(consultation.requestStatus).toBe("REJECTED");
      expect(consultation.appointment).toBeNull();

      // For rejected consultations, we should still show the preferred datetime
      // but mark it as tentative
      const slots = getActualSlots(consultation);
      expect(slots).toHaveLength(1);
      expect(slots[0].isTentative).toBe(true);
      expect(slots[0].date).toEqual(new Date("2024-12-28T03:30:00Z"));
    });
  });

  describe("Time Formatting", () => {
    it("should format time until next session correctly", () => {
      const nextSlot = getActualNextSlotTime(mockEvents[0]);
      const diffInMinutes = Math.floor(
        (nextSlot.date?.getTime() ?? 0 - now.getTime()) / 60000,
      );

      const formatted = formatTimeUntil(diffInMinutes);
      expect(formatted).toMatch(/\d+(\.\d+)?\s+(minutes?|hours?|days?)/);
    });
  });
});
