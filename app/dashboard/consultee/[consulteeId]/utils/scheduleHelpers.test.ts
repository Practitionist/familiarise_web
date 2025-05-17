import { IAppointment } from "@/app/dashboard/consultant/[consultantId]/types";
import { EventWithType } from "@/app/dashboard/consultee/[consulteeId]/utils/getMetadata";
import {
  formatTimeUntil,
  getActualMonthlyEvents,
  getActualNextSlotTime,
  getActualSlots,
  getActualUpcomingSlots,
} from "@/app/dashboard/consultee/[consulteeId]/utils/scheduleHelpers";
import { eventWithoutSlots, mockEvents, pastEvent } from "../mockData";

describe("Schedule Data Consistency Tests", () => {
  const now = new Date("2024-12-28T00:00:00Z");

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
        ({
          appointment,
        }: {
          appointment: IAppointment;
          slot: any;
          isTentative: boolean;
        }) => {
          if (appointment.appointmentType !== "SUBSCRIPTION") return false;
          const subscriptionDetails = appointment.subscription;
          return (
            subscriptionDetails?.subscriptionPlan?.title ===
            "Basic Subscription"
          );
        },
      );

      const expectedDays = [2]; // Only one slot in the test data
      subscriptionSlots.forEach(
        (
          {
            slot,
          }: {
            appointment: any;
            slot: { slotStartTimeInUTC: Date };
            isTentative: boolean;
          },
          index: number,
        ) => {
          const diffInDays = Math.floor(
            (slot.slotStartTimeInUTC.getTime() - now.getTime()) /
              (1000 * 60 * 60 * 24),
          );
          expect(diffInDays).toBe(expectedDays[index]);
        },
      );
    });

    it('should mark tentative schedules as "Subject to change"', () => {
      const slots = mockEvents.flatMap((event: EventWithType) =>
        getActualSlots(event),
      );

      const checkSlotTentativeStatus = (
        eventType: string,
        expectedTentative: boolean,
      ) => {
        // Filter events first, then get slots for those events
        const relevantSlots = mockEvents
          .filter((event) => event.type === eventType)
          .flatMap((event) => getActualSlots(event)); // getActualSlots already filters for future slots

        // Assert that there are relevant slots to check before iterating
        expect(relevantSlots.length).toBeGreaterThan(0);

        // Now, check the tentative status for all relevant (future) slots
        relevantSlots.forEach(
          (slot: { slotStartTimeInUTC: Date; isTentative: boolean }) => {
            expect(slot.isTentative).toBe(expectedTentative);
          },
        );
      };

      // Check subscription slots (should be tentative)
      checkSlotTentativeStatus("Subscription", true);

      // Check completed class slots (should not be tentative)
      checkSlotTentativeStatus("Class", false);
    });

    it("should show same events in upcoming slots and monthly view", () => {
      // Get all slots for January 2025
      const january2025 = new Date("2025-01-01T00:00:00Z");
      const monthlyEvents = getActualMonthlyEvents(mockEvents, january2025);

      // Get upcoming slots that fall in January 2025
      const upcomingSlotsInJan = getActualUpcomingSlots(mockEvents).filter(
        ({
          slot,
        }: {
          appointment: any;
          slot: { slotStartTimeInUTC: Date };
          isTentative: boolean;
        }) => {
          const slotTime = slot.slotStartTimeInUTC;
          return (
            slotTime.getMonth() === january2025.getMonth() &&
            slotTime.getFullYear() === january2025.getFullYear()
          );
        },
      );

      // Each upcoming slot should be in monthly view
      upcomingSlotsInJan.forEach(
        ({
          appointment,
          slot,
        }: {
          appointment: IAppointment;
          slot: { slotStartTimeInUTC: Date };
          isTentative: boolean;
        }) => {
          const foundInMonthly = monthlyEvents.some(
            (monthly: {
              event: EventWithType;
              slots: Array<{ slotStartTimeInUTC: Date }>;
            }) =>
              monthly.event.id === (appointment as any).id &&
              monthly.slots.some(
                (monthlySlot: { slotStartTimeInUTC: Date }) =>
                  monthlySlot.slotStartTimeInUTC.getTime() ===
                  slot.slotStartTimeInUTC.getTime(),
              ),
          );
          expect(foundInMonthly).toBe(true);
        },
      );

      // Each monthly slot should be in upcoming view
      monthlyEvents.forEach(
        (monthly: {
          event: EventWithType;
          slots: Array<{ slotStartTimeInUTC: Date }>;
        }) => {
          monthly.slots.forEach((monthlySlot: { slotStartTimeInUTC: Date }) => {
            // Find corresponding slot in upcomingSlots
            const upcomingSlot = upcomingSlotsInJan.find(
              ({
                slot,
              }: {
                appointment: any;
                slot: { slotStartTimeInUTC: Date };
                isTentative: boolean;
              }) =>
                slot.slotStartTimeInUTC.getTime() ===
                monthlySlot.slotStartTimeInUTC.getTime(),
            );
            expect(upcomingSlot).toBeDefined();
          });
        },
      );
    });

    it("should maintain COMPLETED status for class events", () => {
      const classEvent = mockEvents.find(
        (event: EventWithType) =>
          event.type === "Class" &&
          event.classPlan.consultantProfile?.user?.name === "Mr. Santos Murray",
      );
      if (!classEvent || classEvent.type !== "Class") {
        throw new Error("Class event not found");
      }
      expect(classEvent.status).toBe("COMPLETED");
    });

    it("should maintain REJECTED status for subscription events", () => {
      const subscriptionEvent = mockEvents.find(
        (event: EventWithType) => event.type === "Subscription",
      );
      if (!subscriptionEvent || subscriptionEvent.type !== "Subscription") {
        throw new Error("Subscription event not found");
      }
      expect(subscriptionEvent.requestStatus).toBe("REJECTED");
    });

    it("should maintain REJECTED status for consultation events", () => {
      const consultationEvent = mockEvents.find(
        (event: EventWithType) => event.type === "Consultation",
      );
      if (!consultationEvent || consultationEvent.type !== "Consultation") {
        throw new Error("Consultation event not found");
      }
      expect(consultationEvent.requestStatus).toBe("REJECTED");
    });

    it("should show correct time slots for Intermediate Class", () => {
      const classEvent = mockEvents.find(
        (event: EventWithType) =>
          event.type === "Class" &&
          event.classPlan.title === "Intermediate Class",
      );
      if (!classEvent || classEvent.type !== "Class") {
        throw new Error("Class event not found");
      }

      const slots = getActualSlots(classEvent);
      expect(slots).toHaveLength(2);

      // Verify specific time slots from the UI
      expect(slots[0].slotStartTimeInUTC).toEqual(
        new Date("2025-01-01T12:00:00Z"),
      );
      expect(slots[1].slotStartTimeInUTC).toEqual(
        new Date("2025-01-08T13:00:00Z"),
      );
    });

    it("should handle rejected consultations correctly", () => {
      const consultation = mockEvents.find(
        (event: EventWithType) => event.type === "Consultation",
      );
      if (!consultation || consultation.type !== "Consultation") {
        throw new Error("Consultation event not found");
      }

      expect(consultation.requestStatus).toBe("REJECTED");
      expect(consultation.appointment).toEqual({
        id: "appointment-3",
        appointmentType: "CONSULTATION",
        slotsOfAppointment: [],
        payment: [],
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });

      const slots = getActualSlots(consultation);
      expect(slots).toHaveLength(0);
    });
  });

  describe("Time Formatting", () => {
    it("should format time until next session correctly", () => {
      const nextSlot = getActualNextSlotTime(mockEvents[0]);
      expect(nextSlot).not.toBeNull();
      expect(nextSlot!.slotStartTimeInUTC).toEqual(
        new Date("2024-12-30T13:00:00Z"),
      );

      // Calculate difference in minutes and pass to formatTimeUntil
      const diffInMinutes = Math.floor(
        (nextSlot!.slotStartTimeInUTC.getTime() - now.getTime()) / 60000,
      );
      const formattedTime = formatTimeUntil(diffInMinutes);
      expect(formattedTime).toBe("2 days away");
    });

    it("should format days and hours correctly", () => {
      const days = formatTimeUntil(1500); // 1 day 1 hour
      expect(days).toBe("1 day away");

      const hours = formatTimeUntil(125); // 2 hours 5 mins
      expect(hours).toBe("2 hrs 5 mins away");

      const minutes = formatTimeUntil(45); // 45 mins
      expect(minutes).toBe("45 mins away");
    });

    it("should return null if no upcoming slots for next slot time", () => {
      const nextSlotTime = getActualNextSlotTime(pastEvent);
      expect(nextSlotTime).toBeNull();
    });

    it("should return null if no upcoming slots for formatTimeUntil", () => {
      const nextSlotForFormat = getActualNextSlotTime(pastEvent);
      expect(nextSlotForFormat).toBeNull();
    });

    it("should format correctly", () => {
      const time1 = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours away
      const diff1 = Math.floor((time1.getTime() - now.getTime()) / 60000);
      expect(formatTimeUntil(diff1)).toBe("2 hrs away");

      const time2 = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days away
      const diff2 = Math.floor((time2.getTime() - now.getTime()) / 60000);
      expect(formatTimeUntil(diff2)).toBe("3 days away");
    });
  });

  describe("getActualSlots Edge Cases", () => {
    it("should handle empty appointments", () => {
      const event = {
        type: "Class",
        classPlan: {
          id: "test-plan",
          title: "Test Plan",
          consultantProfile: {
            user: {
              id: "test-user",
              name: "Test User",
              email: "test@example.com",
              image: null,
              phone: null,
              address: null,
              onlineStatus: false,
              currentTimezone: null,
              onboardingCompleted: false,
              role: "CONSULTANT",
              consultantProfileId: null,
              emailVerified: null,
              consulteeProfileId: null,
              staffProfileId: null,
            },
          },
        },
        appointments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as EventWithType;

      const slots = getActualSlots(event);
      expect(slots).toHaveLength(0);
    });

    it("should handle undefined slots", () => {
      const event = {
        type: "Consultation",
        consultationPlan: {
          id: "test-plan",
          title: "Test Plan",
          consultantProfile: {
            user: {
              id: "test-user",
              name: "Test User",
              email: "test@example.com",
              image: null,
              phone: null,
              address: null,
              onlineStatus: false,
              currentTimezone: null,
              onboardingCompleted: false,
              role: "CONSULTANT",
              consultantProfileId: null,
              emailVerified: null,
              consulteeProfileId: null,
              staffProfileId: null,
            },
          },
        },
        requestedBy: {
          id: "test-user",
          name: "Test User",
          email: "test@example.com",
          image: null,
          phone: null,
          address: null,
          onlineStatus: false,
          currentTimezone: null,
          onboardingCompleted: false,
          role: "CONSULTANT",
          consultantProfileId: null,
          emailVerified: null,
          consulteeProfileId: null,
          staffProfileId: null,
        },
        appointment: {
          id: "test-appointment",
          appointmentType: "CONSULTATION",
          slotsOfAppointment: undefined,
          payment: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as EventWithType;

      const slots = getActualSlots(event);
      expect(slots).toHaveLength(0);
    });

    it("should handle past slots correctly", () => {
      const event = {
        type: "Class",
        classPlan: {
          id: "test-plan",
          title: "Test Plan",
          consultantProfile: {
            user: {
              id: "test-user",
              name: "Test User",
              email: "test@example.com",
              image: null,
              phone: null,
              address: null,
              onlineStatus: false,
              currentTimezone: null,
              onboardingCompleted: false,
              role: "CONSULTANT",
              consultantProfileId: null,
              emailVerified: null,
              consulteeProfileId: null,
              staffProfileId: null,
            },
          },
        },
        appointments: [
          {
            id: "test-appointment",
            appointmentType: "CLASS",
            slotsOfAppointment: [
              {
                slotStartTimeInUTC: "2023-01-01T10:00:00Z",
                slotEndTimeInUTC: "2023-01-01T11:00:00Z",
                isTentative: false,
                user: [],
              },
            ],
            payment: [],
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as EventWithType;

      const slots = getActualSlots(event);
      expect(slots).toHaveLength(0);
    });

    it("getActualSlots returns correct slots", () => {
      const slots = getActualSlots(mockEvents[1]);
      expect(slots.length).toBe(2);
    });

    it("should handle event with no slots correctly", () => {
      const slots = getActualSlots(eventWithoutSlots);
      expect(slots).toEqual([]);
      const nextSlotFromNoSlots = getActualNextSlotTime(eventWithoutSlots);
      expect(nextSlotFromNoSlots).toBeNull();
    });
  });

  describe("getActualUpcomingSlots Edge Cases", () => {
    it("should filter out past class slots", () => {
      const upcoming = getActualUpcomingSlots(mockEvents);

      // Should filter out past class slots (Dec 18, Dec 25)
      // Should keep future class slots (Jan 1, Jan 8)
      // Should keep future subscription slot (Dec 30)
      expect(upcoming.length).toBe(3);

      // Verify the structure and times
      expect(upcoming[0].slot.slotStartTimeInUTC).toEqual(
        new Date("2024-12-30T13:00:00Z"),
      );
      expect(upcoming[0].appointment.appointmentType).toBe("SUBSCRIPTION");
      expect(upcoming[0].slot.isTentative).toBe(true);

      expect(upcoming[1].slot.slotStartTimeInUTC).toEqual(
        new Date("2025-01-01T12:00:00Z"),
      );
      expect(upcoming[1].appointment.appointmentType).toBe("CLASS");
      expect(upcoming[1].slot.isTentative).toBe(false);

      expect(upcoming[2].slot.slotStartTimeInUTC).toEqual(
        new Date("2025-01-08T13:00:00Z"),
      );
      expect(upcoming[2].appointment.appointmentType).toBe("CLASS");
      expect(upcoming[2].slot.isTentative).toBe(false);
    });
  });

  describe("getActualMonthlyEvents Edge Cases", () => {
    it("should group correctly", () => {
      const janEvents = getActualMonthlyEvents(
        mockEvents,
        new Date("2025-01-01T00:00:00Z"),
      );

      // Should only contain the Class event with its Jan slots
      expect(janEvents.length).toBe(1);
      expect(janEvents[0].event.type).toBe("Class");
      expect(janEvents[0].slots.length).toBe(2);
      expect(janEvents[0].slots[0].slotStartTimeInUTC).toEqual(
        new Date("2025-01-01T12:00:00Z"),
      );
      expect(janEvents[0].slots[1].slotStartTimeInUTC).toEqual(
        new Date("2025-01-08T13:00:00Z"),
      );
    });
  });

  describe("formatTimeUntil Edge Cases", () => {
    it("should format correctly", () => {
      const time1 = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours away
      const diff1 = Math.floor((time1.getTime() - now.getTime()) / 60000);
      expect(formatTimeUntil(diff1)).toBe("2 hrs away");

      const time2 = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days away
      const diff2 = Math.floor((time2.getTime() - now.getTime()) / 60000);
      expect(formatTimeUntil(diff2)).toBe("3 days away");
    });
  });

  describe("getActualNextSlotTime Edge Cases", () => {
    it("should find the absolute next slot", () => {
      const nextSlotResult = getActualNextSlotTime(mockEvents[0]);
      expect(nextSlotResult?.slotStartTimeInUTC.toISOString()).toBe(
        "2024-12-30T13:00:00.000Z",
      );
    });

    it("should handle only past events", () => {
      const nextSlotFromPast = getActualNextSlotTime(pastEvent);
      expect(nextSlotFromPast).toBeNull();
    });

    it("should return null if no upcoming slots for next slot time", () => {
      const nextSlotTime = getActualNextSlotTime(pastEvent);
      expect(nextSlotTime).toBeNull();
    });

    it("should return null if no upcoming slots for formatTimeUntil", () => {
      const nextSlotForFormat = getActualNextSlotTime(pastEvent);
      expect(nextSlotForFormat).toBeNull();
    });
  });
});
