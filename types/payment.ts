import { 
  AppointmentsType, 
  PaymentGateway, 
  PaymentStatus,
  RequestStatus,
  ClassStatus,
  WebinarStatus,
  User,
  ConsulteeProfile,
  ConsultantProfile,
  Payment,
  Appointment,
  SlotOfAppointment
} from "@prisma/client";

// Enhanced type definitions for better type safety

// Base appointment plan interface
export interface BaseAppointmentPlan {
  id: string;
  title: string;
  description?: string | null;
  price: number;
  language?: string | null;
  level?: string | null;
  prerequisites?: string | null;
  materialProvided?: string | null;
  learningOutcomes: string[];
  consultantProfile: ConsultantProfileWithUser | null;
  createdAt: Date;
  updatedAt: Date;
}

// Consultant profile with user data
export interface ConsultantProfileWithUser extends Omit<ConsultantProfile, 'user'> {
  user: Pick<User, 'id' | 'name' | 'email' | 'image'>;
}

// User with profile information
export interface UserWithProfile extends User {
  consulteeProfile?: ConsulteeProfile | null;
  consultantProfile?: ConsultantProfile | null;
}

// Enhanced payment record with relations
export interface PaymentWithRelations extends Payment {
  user: UserWithProfile;
  appointment?: AppointmentWithSlots | null;
  discountCode?: {
    id: string;
    code: string;
    discountType: string;
    discountValue: number;
  } | null;
}

// Appointment with slots and related data
export interface AppointmentWithSlots extends Appointment {
  slotsOfAppointment: SlotOfAppointment[];
  payment: Payment[];
  consultation?: {
    id: string;
    requestStatus: RequestStatus;
    consultationPlan: BaseAppointmentPlan;
  } | null;
  subscription?: {
    id: string;
    requestStatus: RequestStatus;
    subscriptionPlan: BaseAppointmentPlan & {
      durationInMonths: number;
      callsPerWeek: number;
    };
  } | null;
  webinar?: {
    id: string;
    status: WebinarStatus;
    webinarPlan: BaseAppointmentPlan & {
      maxParticipants: number;
    };
  } | null;
  class?: {
    id: string;
    status: ClassStatus;
    classPlan: BaseAppointmentPlan & {
      maxParticipants: number;
      durationInMonths: number;
    };
  } | null;
}

// Checkout operation types
export interface CheckoutContext {
  userId: string;
  appointmentType: AppointmentsType;
  planId: string;
  eventId?: string;
  paymentGateway: PaymentGateway;
  amount: number;
  currency: string;
  discountCodeId?: string | null;
}

export type CheckoutResult = 
  | {
      success: true;
      paymentIntent: any;
      message: string;
      amount: number;
      currency: string;
    }
  | {
      success: true;
      message: string;
      appointmentId: string;
      skipPayment: true;
    }
  | {
      success: false;
      error: string;
      errorType?: string;
    };

// Slot validation types
export interface SlotValidationContext {
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
  appointmentType: AppointmentsType;
  userId?: string;
  planId: string;
  eventId?: string;
}

export interface SlotValidationResult {
  isValid: boolean;
  error?: string;
  conflictingSlots?: SlotOfAppointment[];
  suggestedAlternatives?: Date[];
}

// Payment intent metadata structure
export interface PaymentIntentMetadata {
  appointmentId: string;
  appointmentType: string;
  userId: string;
  planId: string;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  slotOfAvailabilityWeeklyId?: string;
  slotOfAvailabilityCustomId?: string;
  discountCode?: string;
  notes?: string;
  eventId?: string;
}

// Cleanup operation results
export interface CleanupResults {
  expiredPayments: number;
  cancelledIntents: number;
  cleanedSlots: number;
  orphanedSlots: number;
  resolvedConflicts: number;
  startTime: Date;
  endTime: Date | null;
  duration: number;
}

// Rate limiting types
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  keyGenerator?: (req: any, userId?: string) => string;
}

// Webhook verification types
export interface WebhookVerificationResult {
  isValid: boolean;
  body: string;
  eventId?: string;
}

export interface WebhookEventData {
  eventId: string;
  eventType: string;
  paymentIntentId: string;
  amount?: number;
  currency?: string;
  metadata?: Record<string, string>;
  timestamp: Date;
}

// API response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  errorType?: string;
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Utility types for better type checking
export type AppointmentTypeSpecific<T extends AppointmentsType> = 
  T extends "CONSULTATION" ? "consultation" :
  T extends "SUBSCRIPTION" ? "subscription" :
  T extends "WEBINAR" ? "webinar" :
  T extends "CLASS" ? "class" :
  never;

export type PaymentGatewayConfig = {
  [K in PaymentGateway]: {
    name: string;
    description: string;
    supportedCurrencies: string[];
    environment: "sandbox" | "production";
    webhookEndpoint: string;
  };
};

// Form validation types
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings?: ValidationError[];
}

// Search and filter types
export interface AppointmentFilter {
  appointmentType?: AppointmentsType[];
  status?: (RequestStatus | WebinarStatus | ClassStatus)[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  consultantId?: string;
  consulteeId?: string;
  paymentStatus?: PaymentStatus[];
}

export interface SearchQuery {
  q?: string;
  filters?: AppointmentFilter;
  sort?: {
    field: string;
    direction: "asc" | "desc";
  };
  pagination?: {
    page: number;
    limit: number;
  };
}

// Notification types
export interface NotificationEvent {
  type: "payment_success" | "payment_failed" | "appointment_confirmed" | "appointment_cancelled";
  userId: string;
  appointmentId?: string;
  paymentId?: string;
  data: Record<string, any>;
  timestamp: Date;
}

// Audit log types
export interface AuditLogEntry {
  action: string;
  entityType: "payment" | "appointment" | "user" | "plan";
  entityId: string;
  userId?: string;
  changes?: Record<string, any>;
  metadata?: Record<string, any>;
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
}