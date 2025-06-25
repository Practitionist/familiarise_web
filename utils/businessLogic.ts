import { AppointmentsType, PaymentGateway, PaymentStatus } from "@prisma/client";
import { 
  CheckoutContext, 
  SlotValidationContext, 
  SlotValidationResult,
  PaymentIntentMetadata,
  BaseAppointmentPlan
} from "@/types/payment";
import { AppErrors } from "./errorHandling";

// Shared business logic utilities

export class AppointmentBusinessLogic {
  // Validate appointment timing constraints
  static validateAppointmentTiming(
    appointmentType: AppointmentsType,
    startTime: Date,
    endTime: Date
  ): { isValid: boolean; error?: string } {
    const now = new Date();
    const duration = endTime.getTime() - startTime.getTime();
    const hoursUntilStart = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Common validations
    if (startTime <= now) {
      return { isValid: false, error: "Appointment cannot be scheduled in the past" };
    }

    if (duration <= 0) {
      return { isValid: false, error: "End time must be after start time" };
    }

    // Type-specific validations
    switch (appointmentType) {
      case "CONSULTATION":
        if (hoursUntilStart < 1) {
          return { isValid: false, error: "Consultations must be scheduled at least 1 hour in advance" };
        }
        if (duration < 30 * 60 * 1000) { // 30 minutes
          return { isValid: false, error: "Consultations must be at least 30 minutes long" };
        }
        if (duration > 4 * 60 * 60 * 1000) { // 4 hours
          return { isValid: false, error: "Consultations cannot exceed 4 hours" };
        }
        break;

      case "SUBSCRIPTION":
        if (hoursUntilStart < 24) {
          return { isValid: false, error: "Subscription sessions must be scheduled at least 24 hours in advance" };
        }
        break;

      case "WEBINAR":
        if (hoursUntilStart < 2) {
          return { isValid: false, error: "Webinar registration closes 2 hours before start time" };
        }
        break;

      case "CLASS":
        if (hoursUntilStart < 12) {
          return { isValid: false, error: "Class enrollment closes 12 hours before start time" };
        }
        break;
    }

    return { isValid: true };
  }

  // Calculate appointment pricing with discounts
  static calculatePricing(
    plan: BaseAppointmentPlan,
    discountCode?: {
      discountType: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
      discountValue: number;
    }
  ): {
    originalPrice: number;
    discountAmount: number;
    finalPrice: number;
    currency: string;
  } {
    const originalPrice = plan.price;
    let discountAmount = 0;

    if (discountCode) {
      switch (discountCode.discountType) {
        case "PERCENTAGE":
          discountAmount = originalPrice * (discountCode.discountValue / 100);
          break;
        case "FIXED_AMOUNT":
          discountAmount = Math.min(discountCode.discountValue, originalPrice);
          break;
        case "FREE_SHIPPING":
          // For appointment bookings, this might not apply
          discountAmount = 0;
          break;
      }
    }

    const finalPrice = Math.max(0, originalPrice - discountAmount);

    return {
      originalPrice,
      discountAmount,
      finalPrice,
      currency: "USD", // This should come from plan or system config
    };
  }

  // Generate appointment confirmation details
  static generateAppointmentConfirmation(
    appointmentType: AppointmentsType,
    plan: BaseAppointmentPlan,
    startTime: Date,
    endTime: Date
  ): {
    confirmationNumber: string;
    title: string;
    description: string;
    duration: string;
    instructions: string[];
  } {
    const confirmationNumber = `${appointmentType.substring(0, 3)}-${Date.now().toString(36).toUpperCase()}`;
    const duration = this.formatDuration(endTime.getTime() - startTime.getTime());

    const baseInstructions = [
      "You will receive a meeting link 15 minutes before the scheduled time",
      "Please ensure you have a stable internet connection",
      "Have any relevant materials ready for the session",
    ];

    const typeSpecificInstructions: Record<AppointmentsType, string[]> = {
      CONSULTATION: [
        ...baseInstructions,
        "Prepare any specific questions you'd like to discuss",
        "Consider your goals for this consultation",
      ],
      SUBSCRIPTION: [
        ...baseInstructions,
        "This is part of your ongoing subscription plan",
        "Review previous session notes if applicable",
      ],
      WEBINAR: [
        "Join the webinar using the provided link",
        "You can participate via Q&A during the session",
        "Recording will be available after the webinar",
      ],
      CLASS: [
        "Ensure you have completed any prerequisite materials",
        "Class materials will be shared before the session",
        "Active participation is encouraged",
      ],
    };

    return {
      confirmationNumber,
      title: plan.title,
      description: plan.description || `${appointmentType.toLowerCase()} session`,
      duration,
      instructions: typeSpecificInstructions[appointmentType],
    };
  }

  // Format duration in human-readable format
  private static formatDuration(milliseconds: number): string {
    const hours = Math.floor(milliseconds / (1000 * 60 * 60));
    const minutes = Math.floor((milliseconds % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0 && minutes > 0) {
      return `${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h`;
    } else {
      return `${minutes}m`;
    }
  }

  // Validate participant limits for group events
  static validateParticipantLimits(
    appointmentType: AppointmentsType,
    currentParticipants: number,
    maxParticipants: number
  ): { canJoin: boolean; spotsRemaining: number; error?: string } {
    if (appointmentType === "CONSULTATION" || appointmentType === "SUBSCRIPTION") {
      // These are typically 1-on-1
      return {
        canJoin: currentParticipants === 0,
        spotsRemaining: currentParticipants === 0 ? 1 : 0,
        error: currentParticipants > 0 ? "This session is already booked" : undefined,
      };
    }

    const spotsRemaining = maxParticipants - currentParticipants;
    const canJoin = spotsRemaining > 0;

    return {
      canJoin,
      spotsRemaining,
      error: !canJoin ? `This ${appointmentType.toLowerCase()} is full` : undefined,
    };
  }
}

export class PaymentBusinessLogic {
  // Determine payment gateway based on user location/currency
  static selectOptimalPaymentGateway(
    userCountry?: string,
    currency?: string,
    amount?: number
  ): PaymentGateway {
    // Default to Stripe for international
    if (!userCountry) return "STRIPE";

    // India-specific logic
    if (userCountry === "IN" || currency === "INR") {
      return "RAZORPAY";
    }

    // European logic
    if (["DE", "FR", "NL", "BE", "ES"].includes(userCountry)) {
      return "STRIPE"; // or could be LEMON_SQUEEZY for EU
    }

    // Default fallback
    return "STRIPE";
  }

  // Calculate payment processing fees
  static calculateProcessingFees(
    amount: number,
    currency: string,
    gateway: PaymentGateway
  ): {
    gatewayFee: number;
    platformFee: number;
    totalFees: number;
    netAmount: number;
  } {
    const feeStructures: Record<PaymentGateway, { percentage: number; fixed: number }> = {
      STRIPE: { percentage: 2.9, fixed: 0.30 },
      RAZORPAY: { percentage: 2.0, fixed: 0 },
      LEMON_SQUEEZY: { percentage: 5.0, fixed: 0.50 },
      XFLOW: { percentage: 2.5, fixed: 0.25 },
      CARD: { percentage: 3.0, fixed: 0 },
    };

    const feeStructure = feeStructures[gateway];
    const gatewayFee = (amount * feeStructure.percentage / 100) + feeStructure.fixed;
    const platformFee = amount * 0.05; // 5% platform fee
    const totalFees = gatewayFee + platformFee;
    const netAmount = amount - totalFees;

    return {
      gatewayFee: Math.round(gatewayFee * 100) / 100,
      platformFee: Math.round(platformFee * 100) / 100,
      totalFees: Math.round(totalFees * 100) / 100,
      netAmount: Math.round(netAmount * 100) / 100,
    };
  }

  // Generate payment metadata
  static generatePaymentMetadata(context: CheckoutContext): PaymentIntentMetadata {
    return {
      appointmentId: "pending",
      appointmentType: context.appointmentType,
      userId: context.userId,
      planId: context.planId,
      ...(context.eventId && { eventId: context.eventId }),
    };
  }

  // Validate payment amount consistency
  static validatePaymentAmount(
    expectedAmount: number,
    receivedAmount: number,
    currency: string,
    tolerance: number = 0.01
  ): { isValid: boolean; error?: string } {
    const difference = Math.abs(expectedAmount - receivedAmount);
    
    if (difference > tolerance) {
      return {
        isValid: false,
        error: `Payment amount mismatch: expected ${expectedAmount} ${currency}, received ${receivedAmount} ${currency}`,
      };
    }

    return { isValid: true };
  }
}

export class NotificationBusinessLogic {
  // Generate notification content based on event type
  static generateNotificationContent(
    eventType: string,
    data: Record<string, any>
  ): {
    title: string;
    message: string;
    actionUrl?: string;
    priority: "low" | "medium" | "high";
  } {
    const templates: Record<string, any> = {
      payment_success: {
        title: "Payment Successful",
        message: `Your payment of ${data.amount} ${data.currency} has been processed successfully.`,
        actionUrl: `/dashboard/consultee`,
        priority: "medium",
      },
      payment_failed: {
        title: "Payment Failed",
        message: "Your payment could not be processed. Please try again or contact support.",
        actionUrl: `/checkout/retry/${data.paymentId}`,
        priority: "high",
      },
      appointment_confirmed: {
        title: "Appointment Confirmed",
        message: `Your ${data.appointmentType.toLowerCase()} has been confirmed for ${data.startTime}.`,
        actionUrl: `/appointments/${data.appointmentId}`,
        priority: "medium",
      },
      appointment_cancelled: {
        title: "Appointment Cancelled",
        message: `Your ${data.appointmentType.toLowerCase()} has been cancelled. You will receive a full refund.`,
        actionUrl: `/dashboard/consultee`,
        priority: "high",
      },
    };

    return templates[eventType] || {
      title: "Notification",
      message: "You have a new notification.",
      priority: "low",
    };
  }
}

// Utility functions for common validations
export const ValidationUtils = {
  isValidEmail: (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  isValidPhoneNumber: (phone: string): boolean => {
    const phoneRegex = /^\+?[\d\s\-\(\)]{10,}$/;
    return phoneRegex.test(phone);
  },

  isValidTimeSlot: (start: Date, end: Date): boolean => {
    return start < end && start > new Date();
  },

  sanitizeString: (input: string): string => {
    return input.trim().replace(/[<>]/g, "");
  },

  validateRequired: (value: any, fieldName: string): void => {
    if (value === null || value === undefined || value === "") {
      throw AppErrors.validationError(`${fieldName} is required`);
    }
  },
};

// Export all business logic utilities
export {
  AppointmentBusinessLogic as Appointments,
  PaymentBusinessLogic as Payments,
  NotificationBusinessLogic as Notifications,
};