import {
  getActualNextSlotTime,
  getActualUpcomingSlots,
  getActualMonthlyEvents,
  formatTimeUntil,
  getActualSlots,
} from './actual-schedule';
import { EventWithType } from '../utils';

describe('Schedule Data Consistency Tests', () => {
  const consulteeIds = ['73318747-3425-4bb6-bba7-c3d6a6798441'];
  const now = new Date('2024-12-28T00:00:00Z');

  // Mock events based on HomeTab and Overview screenshots
  const mockEvents: EventWithType[] = [
    // Basic Subscription with Dean Steuber
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
          startTime: '2024-12-30T13:00:00Z', // 2 days from now
          endTime: '2024-12-30T15:00:00Z',
          timezone: 'UTC'
        }
      ])
    } as EventWithType,

    // Intermediate Class with Mr. Santos Murray (COMPLETED)
    {
      id: 'class-1',
      type: 'Class',
      status: 'COMPLETED',
      classPlan: {
        title: 'Intermediate Class',
        consultantProfile: {
          user: {
            name: 'Mr. Santos Murray',
            image: null
          }
        }
      },
      tentativeSchedule: JSON.stringify([
        {
          startTime: '2024-12-18T15:00:00Z',
          endTime: '2024-12-18T17:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2024-12-25T13:00:00Z',
          endTime: '2024-12-25T16:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2025-01-01T12:00:00Z',
          endTime: '2025-01-01T13:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2025-01-08T13:00:00Z',
          endTime: '2025-01-08T14:00:00Z',
          timezone: 'UTC'
        }
      ])
    } as EventWithType,

    // Second Intermediate Class with Mona Howe (CANCELLED)
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
        },
        {
          startTime: '2025-01-29T13:00:00Z',
          endTime: '2025-01-29T14:00:00Z',
          timezone: 'UTC'
        },
        {
          startTime: '2025-02-05T15:00:00Z',
          endTime: '2025-02-05T18:00:00Z',
          timezone: 'UTC'
        }
      ])
    } as EventWithType,

    // Extended Consultation with Francis Daniel
    {
      id: 'consultation-1',
      type: 'Consultation',
      requestStatus: 'REJECTED',
      consultationPlan: {
        title: 'Extended Consultation',
        consultantProfile: {
          user: {
            name: 'Francis Daniel',
            image: null
          }
        }
      },
      preferredDateTime: '2024-12-28T03:30:00Z',
      // Rejected consultations should not have appointments
      appointment: null
    } as EventWithType
  ];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('UI Data Consistency', () => {
    it('should show correct "days away" count in both views', () => {
      const upcomingSlots = getActualUpcomingSlots(mockEvents);
      
      // Check Basic Subscription slots (2 days, 9 days, 16 days, 23 days away)
      const subscriptionSlots = upcomingSlots.filter(({ event }) => 
        event.type === 'Subscription' && event.subscriptionPlan.title === 'Basic Subscription'
      );
      
      const expectedDays = [2, 9, 16, 23]; // From UI screenshot
      subscriptionSlots.forEach(({ slotTime }, index) => {
        const diffInDays = Math.floor((slotTime.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        expect(diffInDays).toBe(expectedDays[index]);
      });
    });

    it('should maintain CANCELLED status for Mona Howe\'s class', () => {
      const monaClass = mockEvents.find(e => 
        e.type === 'Class' && 
        e.classPlan.consultantProfile.user.name === 'Mona Howe'
      );
      expect(monaClass).toBeDefined();
      expect(monaClass!.status).toBe('CANCELLED');

      // Verify slots are still accessible even when cancelled
      const slots = getActualSlots(monaClass!);
      expect(slots).toHaveLength(4);
      expect(slots[0].date).toEqual(new Date('2025-01-15T10:00:00Z'));
    });

    it('should mark tentative schedules as "Subject to change"', () => {
      const slots = mockEvents.flatMap(event => getActualSlots(event));
      
      // All subscription slots should be marked as tentative
      const subscriptionSlots = slots.filter(slot => 
        mockEvents.some(e => 
          e.type === 'Subscription' && 
          e.tentativeSchedule?.includes(slot.date.toISOString())
        )
      );
      subscriptionSlots.forEach(slot => {
        expect(slot.isTentative).toBe(true);
      });

      // Completed class slots should not be tentative
      const completedClassSlots = slots.filter(slot =>
        mockEvents.some(e =>
          e.type === 'Class' &&
          e.status === 'COMPLETED' &&
          e.tentativeSchedule?.includes(slot.date.toISOString())
        )
      );
      completedClassSlots.forEach(slot => {
        expect(slot.isTentative).toBe(false);
      });
    });

    it('should show same events in upcoming slots and monthly view', () => {
      // Get all slots for January 2025
      const january2025 = new Date('2025-01-01T00:00:00Z');
      const monthlyEvents = getActualMonthlyEvents(mockEvents, january2025);
      
      // Get upcoming slots that fall in January 2025
      const upcomingSlots = getActualUpcomingSlots(mockEvents)
        .filter(({ slotTime }) => 
          slotTime.getMonth() === january2025.getMonth() && 
          slotTime.getFullYear() === january2025.getFullYear()
        );

      // Each upcoming slot should be in monthly view
      upcomingSlots.forEach(({ event, slotTime }) => {
        const foundInMonthly = monthlyEvents.some(monthly => 
          monthly.event.id === event.id && 
          monthly.slots.some(slot => slot.date.getTime() === slotTime.getTime())
        );
        expect(foundInMonthly).toBe(true);
      });

      // Each monthly slot should be in upcoming slots
      monthlyEvents.forEach(monthly => {
        monthly.slots.forEach(monthlySlot => {
          const foundInUpcoming = upcomingSlots.some(({ slotTime }) => 
            slotTime.getTime() === monthlySlot.date.getTime()
          );
          expect(foundInUpcoming).toBe(true);
        });
      });
    });

    it('should maintain correct status for class events', () => {
      const upcomingSlots = getActualUpcomingSlots(mockEvents);
      const classEvents = upcomingSlots.filter(({ event }) => event.type === 'Class');
      
      // Find specific class events by consultant
      const santosClass = classEvents.find(({ event }) => 
        event.classPlan.consultantProfile.user.name === 'Mr. Santos Murray'
      );
      const monaClass = classEvents.find(({ event }) => 
        event.classPlan.consultantProfile.user.name === 'Mona Howe'
      );

      // Verify their respective statuses
      expect(santosClass?.event.status).toBe('COMPLETED');
      expect(monaClass?.event.status).toBe('CANCELLED');
    });

    it('should maintain REJECTED status for subscription events', () => {
      const upcomingSlots = getActualUpcomingSlots(mockEvents);
      const subscriptionEvents = upcomingSlots.filter(({ event }) => event.type === 'Subscription');
      subscriptionEvents.forEach(({ event }) => {
        expect(event.requestStatus).toBe('REJECTED');
      });
    });

    it('should maintain REJECTED status for consultation events', () => {
      const upcomingSlots = getActualUpcomingSlots(mockEvents);
      const consultationEvents = upcomingSlots.filter(({ event }) => event.type === 'Consultation');
      consultationEvents.forEach(({ event }) => {
        expect(event.requestStatus).toBe('REJECTED');
      });
    });

    it('should show correct time slots for Intermediate Class', () => {
      const classEvent = mockEvents.find(e => e.type === 'Class' && e.classPlan.title === 'Intermediate Class');
      expect(classEvent).toBeDefined();

      const slots = getActualSlots(classEvent!);
      expect(slots).toHaveLength(4);
      
      // Verify specific time slots from the UI
      expect(slots[0].date).toEqual(new Date('2024-12-18T15:00:00Z'));
      expect(slots[1].date).toEqual(new Date('2024-12-25T13:00:00Z'));
      expect(slots[2].date).toEqual(new Date('2025-01-01T12:00:00Z'));
      expect(slots[3].date).toEqual(new Date('2025-01-08T13:00:00Z'));
    });

    it('should handle rejected consultations correctly', () => {
      const consultation = mockEvents.find(e => e.type === 'Consultation');
      expect(consultation).toBeDefined();
      expect(consultation!.requestStatus).toBe('REJECTED');
      expect(consultation!.appointment).toBeNull();

      // For rejected consultations, we should still show the preferred datetime
      // but mark it as tentative
      const slots = getActualSlots(consultation!);
      expect(slots).toHaveLength(1);
      expect(slots[0].isTentative).toBe(true);
      expect(slots[0].date).toEqual(new Date('2024-12-28T03:30:00Z'));
    });
  });

  describe('Time Formatting', () => {
    it('should format time until next session correctly', () => {
      const nextSlot = getActualNextSlotTime(mockEvents[0]);
      const diffInMinutes = Math.floor((nextSlot.date?.getTime() ?? 0 - now.getTime()) / 60000);
      
      const formatted = formatTimeUntil(diffInMinutes);
      expect(formatted).toMatch(/\d+(\.\d+)?\s+(minutes?|hours?|days?)/);
    });
  });
});
