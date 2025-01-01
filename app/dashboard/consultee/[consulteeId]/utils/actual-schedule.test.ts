import {
  getActualNextSlotTime,
  getActualUpcomingSlots,
  getActualMonthlyEvents,
  formatTimeUntil,
  getActualSlots,
} from "./actual-schedule";
import { SlotOfAppointment } from "@prisma/client";
import { EventWithType } from "../utils";

describe("Schedule Data Consistency Tests", () => {
  const now = new Date("2024-12-28T00:00:00Z");
  const mockEvents: EventWithType[] = [
    // Subscription with tentative slot
    {
      id: "subscription-1",
      type: "Subscription",
      requestStatus: "REJECTED",
      subscriptionPlan: { id: "plan-1", title: "Basic Subscription" },
      appointments: [{
        id: "appointment-1",
        slotsOfAppointment: [{
          id: "slot-1",
          slotStartTimeInUTC: new Date("2024-12-30T13:00:00Z"),
          slotEndTimeInUTC: new Date("2024-12-30T15:00:00Z"),
          isTentative: true,
          appointmentId: "appointment-1"
        }],
        payment: []
      }]
    },
    // Class with non-tentative slots
    {
      id: "class-1",
      type: "Class",
      status: "COMPLETED",
      classPlan: { id: "plan-2", title: "Intermediate Class" },
      appointment: [{
        id: "appointment-2",
        slotsOfAppointment: [
          {
            id: "slot-2",
            slotStartTimeInUTC: new Date("2024-12-18T15:00:00Z"),
            slotEndTimeInUTC: new Date("2024-12-18T17:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2"
          },
          {
            id: "slot-3",
            slotStartTimeInUTC: new Date("2024-12-25T13:00:00Z"),
            slotEndTimeInUTC: new Date("2024-12-25T16:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2"
          },
          {
            id: "slot-4",
            slotStartTimeInUTC: new Date("2025-01-01T12:00:00Z"),
            slotEndTimeInUTC: new Date("2025-01-01T13:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2"
          },
          {
            id: "slot-5",
            slotStartTimeInUTC: new Date("2025-01-08T13:00:00Z"),
            slotEndTimeInUTC: new Date("2025-01-08T14:00:00Z"),
            isTentative: false,
            appointmentId: "appointment-2"
          }
        ],
        payment: []
      }]
    },
    // Rejected consultation with no slots
    {
      id: "consultation-1",
      type: "Consultation",
      requestStatus: "REJECTED",
      consultationPlan: { id: "plan-3", title: "Extended Consultation" },
      appointment: null
    }
  ] as EventWithType[];

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
        ({ event }: { event: EventWithType }) =>
          event.type === "Subscription" &&
          event.subscriptionPlan.title === "Basic Subscription",
      );

      const expectedDays = [2]; // Only one slot in the test data
      subscriptionSlots.forEach(({ slotTime }: { slotTime: Date }, index: number) => {
        const diffInDays = Math.floor(
          (slotTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );
        expect(diffInDays).toBe(expectedDays[index]);
      });
    });

    it('should mark tentative schedules as "Subject to change"', () => {
      const slots = mockEvents.flatMap((event: EventWithType) => getActualSlots(event));

      const checkSlotTentativeStatus = (eventType: string, expectedTentative: boolean) => {
        const eventSlots = slots.filter((slot) =>
          mockEvents.some((event: EventWithType) => {
            if (event.type !== eventType) return false;
            
            const appointments = event.type === "Subscription" 
              ? event.appointments 
              : event.appointment ? [event.appointment] : [];
              
            return appointments.some((appointment) => 
              appointment.slotsOfAppointment.some((slotOfAppointment: SlotOfAppointment) => 
                new Date(slotOfAppointment.slotStartTimeInUTC).getTime() === slot.date.getTime()
              )
            );
          }),
        );
        eventSlots.forEach((slot: { date: Date; isTentative: boolean }) => {
          expect(slot.isTentative).toBe(expectedTentative);
        });
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
      const upcomingSlots = getActualUpcomingSlots(mockEvents).filter(
        ({ slotTime }: { slotTime: Date }) =>
          slotTime.getMonth() === january2025.getMonth() &&
          slotTime.getFullYear() === january2025.getFullYear(),
      );

      // Each upcoming slot should be in monthly view
      upcomingSlots.forEach(({ event, slotTime }: { event: EventWithType; slotTime: Date }) => {
        const foundInMonthly = monthlyEvents.some(
          (monthly: { event: EventWithType; slots: Array<{ date: Date }> }) =>
            monthly.event.id === event.id &&
            monthly.slots.some(
              (slot: { date: Date }) => slot.date.getTime() === slotTime.getTime(),
            ),
        );
        expect(foundInMonthly).toBe(true);
      });

      // Each monthly slot should be in upcoming slots
      monthlyEvents.forEach((monthly: { event: EventWithType; slots: Array<{ date: Date }> }) => {
        monthly.slots.forEach((monthlySlot: { date: Date }) => {
          const foundInUpcoming = upcomingSlots.some(
            ({ slotTime }: { slotTime: Date }) => slotTime.getTime() === monthlySlot.date.getTime(),
          );
          expect(foundInUpcoming).toBe(true);
        });
      });
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
        (event: EventWithType) => event.type === "Class" && event.classPlan.title === "Intermediate Class",
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
      const consultation = mockEvents.find((event: EventWithType) => event.type === "Consultation");
      if (!consultation || consultation.type !== "Consultation") {
        throw new Error("Consultation event not found");
      }

      expect(consultation.requestStatus).toBe("REJECTED");
      expect(consultation.appointment).toBeNull();

      // For rejected consultations, slots should be marked as tentative
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
