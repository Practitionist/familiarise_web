import {
  getEventTitle,
  getConsultantName,
  getConsultantImage,
  getConsultantInitial,
  formatDate,
  getEventEndDate,
  isRecurringEvent,
  getRecurringEvents,
  getEventStatus,
  getStatusColor,
  EventWithType
} from './utils';

describe('Event Utility Functions', () => {
  // Mock data for different event types
  const mockConsultationEvent: EventWithType = {
    type: "Consultation",
    consultationPlan: {
      title: "Career Guidance",
      consultantProfile: {
        user: {
          name: "John Doe",
          image: "profile.jpg"
        }
      }
    },
    requestStatus: "PENDING"
  } as EventWithType;

  const mockSubscriptionEvent: EventWithType = {
    type: "Subscription",
    subscriptionPlan: {
      title: "Monthly Mentorship",
      consultantProfile: {
        user: {
          name: "Jane Smith",
          image: "jane.jpg"
        }
      }
    },
    requestStatus: "APPROVED",
    endDate: new Date('2024-12-31')
  } as EventWithType;

  describe('getEventTitle', () => {
    it('should return correct title for consultation event', () => {
      expect(getEventTitle(mockConsultationEvent)).toBe("Career Guidance");
    });

    it('should return correct title for subscription event', () => {
      expect(getEventTitle(mockSubscriptionEvent)).toBe("Monthly Mentorship");
    });
  });

  describe('getConsultantName', () => {
    it('should return consultant name for consultation event', () => {
      expect(getConsultantName(mockConsultationEvent)).toBe("John Doe");
    });

    it('should return "Unknown Consultant" when name is missing', () => {
      const eventWithoutName = {
        ...mockConsultationEvent,
        consultationPlan: {
          ...mockConsultationEvent.consultationPlan,
          consultantProfile: { user: { name: null } }
        }
      } as EventWithType;
      expect(getConsultantName(eventWithoutName)).toBe("Unknown Consultant");
    });
  });

  describe('getConsultantImage', () => {
    it('should return consultant image URL', () => {
      expect(getConsultantImage(mockConsultationEvent)).toBe("profile.jpg");
    });

    it('should return null when image is missing', () => {
      const eventWithoutImage = {
        ...mockConsultationEvent,
        consultationPlan: {
          ...mockConsultationEvent.consultationPlan,
          consultantProfile: { user: { image: null } }
        }
      } as EventWithType;
      expect(getConsultantImage(eventWithoutImage)).toBeNull();
    });
  });

  describe('getConsultantInitial', () => {
    it('should return first letter of consultant name', () => {
      expect(getConsultantInitial(mockConsultationEvent)).toBe("J");
    });

    it('should return "U" for unknown consultant when name is missing', () => {
      const eventWithoutName = {
        ...mockConsultationEvent,
        consultationPlan: {
          ...mockConsultationEvent.consultationPlan,
          consultantProfile: { user: { name: null } }
        }
      } as EventWithType;
      // When name is missing, getConsultantName returns "Unknown Consultant"
      expect(getConsultantInitial(eventWithoutName)).toBe("U");
    });
  });

  describe('formatDate', () => {
    it('should format date correctly', () => {
      const date = new Date('2024-01-01');
      expect(formatDate(date)).toBe(date.toLocaleDateString());
    });

    it('should handle null date', () => {
      expect(formatDate(null)).toBe("Date not set");
    });

    it('should handle undefined date', () => {
      expect(formatDate(undefined)).toBe("Date not set");
    });
  });

  describe('getEventEndDate', () => {
    it('should return end date for subscription event', () => {
      expect(getEventEndDate(mockSubscriptionEvent)).toEqual(new Date('2024-12-31'));
    });

    it('should return null for consultation event', () => {
      expect(getEventEndDate(mockConsultationEvent)).toBeNull();
    });
  });

  describe('isRecurringEvent', () => {
    it('should return true for subscription events', () => {
      expect(isRecurringEvent(mockSubscriptionEvent)).toBe(true);
    });

    it('should return false for consultation events', () => {
      expect(isRecurringEvent(mockConsultationEvent)).toBe(false);
    });
  });

  describe('getRecurringEvents', () => {
    it('should filter and return only recurring events', () => {
      const events = [mockConsultationEvent, mockSubscriptionEvent];
      const recurringEvents = getRecurringEvents(events);
      expect(recurringEvents).toHaveLength(1);
      expect(recurringEvents[0]).toBe(mockSubscriptionEvent);
    });
  });

  describe('getEventStatus', () => {
    it('should return correct status for consultation event', () => {
      expect(getEventStatus(mockConsultationEvent)).toBe("PENDING");
    });

    it('should return correct status for subscription event', () => {
      expect(getEventStatus(mockSubscriptionEvent)).toBe("APPROVED");
    });
  });

  describe('getStatusColor', () => {
    it('should return green color for completed status', () => {
      expect(getStatusColor('completed')).toBe("bg-green-50 text-green-700");
    });

    it('should return red color for rejected status', () => {
      expect(getStatusColor('rejected')).toBe("bg-red-50 text-red-700");
    });

    it('should return yellow color for pending status', () => {
      expect(getStatusColor('pending')).toBe("bg-yellow-50 text-yellow-700");
    });

    it('should return gray color for unknown status', () => {
      expect(getStatusColor('unknown')).toBe("bg-gray-50 text-gray-700");
    });
  });
});
