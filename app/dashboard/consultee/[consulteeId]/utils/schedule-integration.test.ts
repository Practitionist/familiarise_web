import {
  getActualSlots,
  getActualUpcomingSlots,
  getActualMonthlyEvents,
} from "./actual-schedule";
import {
  getPreferredSlots,
  getPreferredUpcomingSlots,
  getPreferredMonthlyEvents,
} from "./preferred-schedule";
import { EventWithType } from "../utils";

describe("Schedule Integration Tests", () => {
  // Test multiple consultee IDs
  const consulteeIds = [
    "73318747-3425-4bb6-bba7-c3d6a6798441",
    "15328195-84ef-47a2-b142-3ea4749c52f6",
  ];
  const now = new Date("2024-12-28T00:00:00Z");

  // Mock events based on UI data
  const mockEvents: Record<string, EventWithType[]> = {
    // First consultee events
    "73318747-3425-4bb6-bba7-c3d6a6798441": [
      {
        id: "subscription-1",
        type: "Subscription",
        requestStatus: "REJECTED",
        subscriptionPlan: {
          title: "Basic Subscription",
          consultantProfile: {
            user: { name: "Dean Steuber" },
          },
        },
        tentativeSchedule: JSON.stringify([
          {
            startTime: "2024-12-31T13:00:00Z",
            endTime: "2024-12-31T15:00:00Z",
          },
        ]),
      } as EventWithType,
      {
        id: "class-1",
        type: "Class",
        status: "CANCELLED",
        classPlan: {
          title: "Intermediate Class",
          consultantProfile: {
            user: { name: "Mona Howe" },
          },
        },
        tentativeSchedule: JSON.stringify([
          {
            startTime: "2025-01-15T10:00:00Z",
            endTime: "2025-01-15T13:00:00Z",
            timezone: "UTC",
          },
          {
            startTime: "2025-01-22T11:00:00Z",
            endTime: "2025-01-22T12:00:00Z",
            timezone: "UTC",
          },
        ]),
      } as EventWithType,
    ],

    // Second consultee events
    "15328195-84ef-47a2-b142-3ea4749c52f6": [
      {
        id: "class-2",
        type: "Class",
        status: "COMPLETED",
        classPlan: {
          title: "Intermediate Class",
          consultantProfile: {
            user: { name: "Mr. Santos Murray" },
          },
        },
        appointment: {
          slotsOfAppointment: [
            {
              slotStartTimeInUTC: "2024-12-18T15:00:00Z",
              slotEndTimeInUTC: "2024-12-18T17:00:00Z",
            },
          ],
        },
      } as EventWithType,
    ],
  };

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe("Multi-Consultee Handling", () => {
    it("should keep events separate for each consultee", () => {
      consulteeIds.forEach((consulteeId) => {
        const events = mockEvents[consulteeId];
        const actualSlots = getActualUpcomingSlots(events);
        const preferredSlots = getPreferredUpcomingSlots(events);

        // Verify no cross-contamination of events
        actualSlots.forEach(({ event }) => {
          expect(events).toContain(event);
        });
        preferredSlots.forEach(({ event }) => {
          expect(events).toContain(event);
        });
      });
    });

    it("should maintain consistent status across consultees", () => {
      // First consultee has REJECTED subscription
      const firstConsulteeEvents = mockEvents[consulteeIds[0]];
      const firstSubscription = firstConsulteeEvents.find(
        (e) => e.type === "Subscription",
      );
      expect(firstSubscription?.requestStatus).toBe("REJECTED");

      // Second consultee has COMPLETED class
      const secondConsulteeEvents = mockEvents[consulteeIds[1]];
      const secondClass = secondConsulteeEvents.find((e) => e.type === "Class");
      expect(secondClass?.status).toBe("COMPLETED");
    });
  });

  describe("Actual vs Preferred Schedule Integration", () => {
    it("should show tentative slots when no actual slots exist", () => {
      consulteeIds.forEach((consulteeId) => {
        const events = mockEvents[consulteeId];
        const eventsWithTentativeSchedule = events.filter(
          (event) =>
            event.tentativeSchedule && getActualSlots(event).length === 0,
        );

        eventsWithTentativeSchedule.forEach((event) => {
          const preferredSlots = getPreferredSlots(event);
          expect(preferredSlots.length).toBeGreaterThan(0);

          const actualSlots = getActualSlots(event);
          actualSlots.forEach((slot) => {
            expect(slot.isTentative).toBe(true);
          });
        });
      });
    });

    it("should prefer actual slots over tentative ones", () => {
      const completedClassEvent = mockEvents[consulteeIds[1]][0]; // Mr. Santos Murray's class
      const actualSlots = getActualSlots(completedClassEvent);
      const preferredSlots = getPreferredSlots(completedClassEvent);

      // For completed events, should use actual slots
      expect(actualSlots.length).toBeGreaterThan(0);
      actualSlots.forEach((slot) => {
        expect(slot.isTentative).toBe(false);
      });
    });
  });

  describe("Monthly View Integration", () => {
    it("should show consistent data between actual and preferred monthly views", () => {
      const events = mockEvents[consulteeIds[0]];
      const january2025 = new Date("2025-01-01T00:00:00Z");
      const actualMonthly = getActualMonthlyEvents(events, january2025);
      const preferredMonthly = getPreferredMonthlyEvents(events, january2025);

      // Get events with slots in January 2025
      const eventsWithJanuarySlots = events.filter((event) => {
        const slots = getActualSlots(event);
        const preferredSlots = getPreferredSlots(event);
        return (
          slots.some((slot) => slot.date.getMonth() === 0) ||
          preferredSlots.some((slot) => slot.getMonth() === 0)
        );
      });

      // Each event with January slots should appear in either actual or preferred view
      eventsWithJanuarySlots.forEach((event) => {
        const inActual = actualMonthly.some((m) => m.event.id === event.id);
        const inPreferred = preferredMonthly.some(
          (m) => m.event.id === event.id,
        );
        expect(inActual || inPreferred).toBe(true);

        // Get actual and preferred slots for January 2025
        const actualSlots = getActualSlots(event).filter(
          (slot) =>
            slot.date.getMonth() === 0 && slot.date.getFullYear() === 2025,
        );
        const preferredSlots = getPreferredSlots(event).filter(
          (slot) => slot.getMonth() === 0 && slot.getFullYear() === 2025,
        );

        // Find corresponding monthly events
        const monthlyActualEvent = actualMonthly.find(
          (m) => m.event.id === event.id,
        );
        const monthlyPreferredEvent = preferredMonthly.find(
          (m) => m.event.id === event.id,
        );

        // For events with actual slots, verify they appear in actual monthly view
        const hasActualSlots = actualSlots.length > 0;
        const hasMonthlyActual = !!monthlyActualEvent;
        expect(hasMonthlyActual).toBe(hasActualSlots);

        // For events with preferred slots, verify they appear in preferred monthly view
        const hasPreferredSlots = preferredSlots.length > 0;
        const hasMonthlyPreferred = !!monthlyPreferredEvent;
        expect(hasMonthlyPreferred).toBe(hasPreferredSlots);

        // Verify slot counts match when present
        monthlyActualEvent?.slots.forEach((slot, index) => {
          expect(slot.date).toEqual(actualSlots[index].date);
        });
        monthlyPreferredEvent?.slots.forEach((slot, index) => {
          expect(slot).toEqual(preferredSlots[index]);
        });
      });
    });

    it("should handle cancelled class slots correctly", () => {
      const cancelledClass = mockEvents[consulteeIds[0]].find(
        (e) => e.type === "Class" && e.status === "CANCELLED",
      );
      expect(cancelledClass).toBeDefined();

      // Cancelled class should show in preferred monthly view
      const preferredMonthly = getPreferredMonthlyEvents(
        [cancelledClass!],
        new Date("2025-01-01"),
      );
      expect(preferredMonthly).toHaveLength(1);
      expect(preferredMonthly[0].event.status).toBe("CANCELLED");
      expect(preferredMonthly[0].slots).toHaveLength(2); // Two January slots

      // Verify specific January slots
      const slots = preferredMonthly[0].slots;
      expect(slots[0]).toEqual(new Date("2025-01-15T10:00:00Z"));
      expect(slots[1]).toEqual(new Date("2025-01-22T11:00:00Z"));
    });
  });
});
