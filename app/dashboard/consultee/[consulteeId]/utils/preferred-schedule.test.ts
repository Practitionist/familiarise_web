import {
  getPreferredSlots,
  getPreferredNextSlotTime,
  getPreferredUpcomingSlots,
  getPreferredMonthlyEvents,
} from './preferred-schedule';
import { EventWithType } from '../utils';

describe('Preferred Schedule Tests', () => {
  const consulteeIds = ['73318747-3425-4bb6-bba7-c3d6a6798441'];
  const now = new Date('2024-12-28T00:00:00Z');

  // Mock events based on UI data
  const mockEvents: EventWithType[] = [
    // Basic Subscription with Dean Steuber (Multiple sessions)
    {
      id: 'subscription-1',
      type: 'Subscription',
      requestStatus: 'REJECTED',
      subscriptionPlan: {
        title: 'Basic Subscription',
        consultantProfile: {
          user: {
            name: 'Dean Steuber',
            image: null
          }
        }
      },
      tentativeSchedule: JSON.stringify([
        {
          startTime: '2024-12-31T13:00:00Z',
          endTime: '2024-12-31T15:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2025-01-07T13:00:00Z',
          endTime: '2025-01-07T15:00:00Z',
          timezone: 'UTC'
        }
      ])
    } as EventWithType,

    // Intermediate Class with Mona Howe (CANCELLED)
    {
      id: 'class-2',
      type: 'Class',
      status: 'CANCELLED',
      classPlan: {
        title: 'Intermediate Class',
        consultantProfile: {
          user: {
            name: 'Mona Howe',
            image: null
          }
        }
      },
      tentativeSchedule: JSON.stringify([
        {
          startTime: '2025-01-15T10:00:00Z',
          endTime: '2025-01-15T13:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2025-01-22T11:00:00Z',
          endTime: '2025-01-22T12:00:00Z',
          timezone: 'UTC'
        }
      ])
    } as EventWithType
  ];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('Preferred Slots', () => {
    it('should get preferred slots from tentative schedule', () => {
      const subscription = mockEvents.find(e => e.type === 'Subscription');
      const slots = getPreferredSlots(subscription!);
      expect(slots).toHaveLength(2);
      expect(slots[0]).toEqual(new Date('2024-12-31T13:00:00Z'));
      expect(slots[1]).toEqual(new Date('2025-01-07T13:00:00Z'));
    });

    it('should handle invalid tentative schedule JSON', () => {
      const invalidEvent = {
        ...mockEvents[0],
        tentativeSchedule: 'invalid json'
      } as EventWithType;
      const slots = getPreferredSlots(invalidEvent);
      expect(slots).toHaveLength(0);
    });
  });

  describe('Next Slot Time', () => {
    it('should get next available preferred slot', () => {
      const subscription = mockEvents.find(e => e.type === 'Subscription');
      const nextSlot = getPreferredNextSlotTime(subscription!);
      expect(nextSlot).toEqual(new Date('2024-12-31T13:00:00Z'));
    });

    it('should return current time if no future slots', () => {
      const pastEvent = {
        ...mockEvents[0],
        tentativeSchedule: JSON.stringify([{
          startTime: '2024-12-20T13:00:00Z',
          endTime: '2024-12-20T15:00:00Z',
          timezone: 'UTC'
        }])
      } as EventWithType;
      const nextSlot = getPreferredNextSlotTime(pastEvent);
      expect(nextSlot).toEqual(now);
    });
  });

  describe('Upcoming Slots', () => {
    it('should get all future preferred slots in order', () => {
      const slots = getPreferredUpcomingSlots(mockEvents);
      expect(slots).toHaveLength(4); // 2 from subscription + 2 from class
      
      // Verify chronological order
      for (let i = 0; i < slots.length - 1; i++) {
        expect(slots[i].slotTime.getTime()).toBeLessThan(slots[i + 1].slotTime.getTime());
      }

      // Verify specific slots
      expect(slots[0].slotTime).toEqual(new Date('2024-12-31T13:00:00Z')); // First subscription slot
      expect(slots[1].slotTime).toEqual(new Date('2025-01-07T13:00:00Z')); // Second subscription slot
      expect(slots[2].slotTime).toEqual(new Date('2025-01-15T10:00:00Z')); // First class slot
      expect(slots[3].slotTime).toEqual(new Date('2025-01-22T11:00:00Z')); // Second class slot
    });

    it('should not include past slots', () => {
      const pastEvent = {
        ...mockEvents[0],
        tentativeSchedule: JSON.stringify([{
          startTime: '2024-12-20T13:00:00Z',
          endTime: '2024-12-20T15:00:00Z',
          timezone: 'UTC'
        }])
      } as EventWithType;
      const slots = getPreferredUpcomingSlots([pastEvent]);
      expect(slots).toHaveLength(0);
    });
  });

  describe('Monthly Events', () => {
    it('should group events by month', () => {
      // Add an event with December slots
      const eventWithDecemberSlots = {
        ...mockEvents[0],
        tentativeSchedule: JSON.stringify([
          {
            startTime: '2024-12-20T13:00:00Z',
            endTime: '2024-12-20T15:00:00Z',
            timezone: 'UTC'
          }
        ])
      } as EventWithType;

      const allEvents = [...mockEvents, eventWithDecemberSlots];

      // Check January events
      const januaryEvents = getPreferredMonthlyEvents(allEvents, new Date('2025-01-01'));
      expect(januaryEvents).toHaveLength(2); // Subscription and Class events in January
      
      januaryEvents.forEach(({ slots }) => {
        slots.forEach(slot => {
          expect(slot.getMonth()).toBe(0); // January is month 0
        });
      });

      // Check December events
      const decemberEvents = getPreferredMonthlyEvents(allEvents, new Date('2024-12-01'));
      expect(decemberEvents).toHaveLength(1); // Event with December slots
      
      decemberEvents.forEach(({ slots }) => {
        slots.forEach(slot => {
          expect(slot.getMonth()).toBe(11); // December is month 11
        });
      });
    });
  });
});
