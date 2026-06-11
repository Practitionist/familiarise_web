/**
 * Waitlist Module
 * Comprehensive waitlist management for webinars and classes
 */

// Queue Manager exports
export {
  calculatePosition,
  getNextInQueue,
  updatePositions,
  processExpiredNotifications,
  getWaitlistStats,
  getUserWaitlistEntries,
} from "./queue-manager";

// Slot Handler exports
export {
  handleSlotOpening,
  handleWaitlistResponse,
  markWaitlistAsBooked,
  checkEventAvailability,
  joinWaitlist,
  leaveWaitlist,
} from "./slot-handler";

// Notification exports
export {
  sendWaitlistJoinedEmail,
  sendWaitlistSpotAvailableEmail,
  sendWaitlistExpiringEmail,
  sendWaitlistExpiredEmail,
} from "./notifications";
