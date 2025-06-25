import { NextResponse } from "next/server";
import { ZodError } from "zod";

// Standardized error types for better error handling
export enum AppErrorType {
  // Authentication & Authorization
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",

  // Validation Errors
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_INPUT = "INVALID_INPUT",

  // Payment & Checkout Errors
  PAYMENT_CONFIG_ERROR = "PAYMENT_CONFIG_ERROR",
  PAYMENT_PROCESSING_ERROR = "PAYMENT_PROCESSING_ERROR",
  PAYMENT_VERIFICATION_FAILED = "PAYMENT_VERIFICATION_FAILED",
  PAYMENT_AMOUNT_MISMATCH = "PAYMENT_AMOUNT_MISMATCH",

  // Database & Resource Errors
  DATABASE_ERROR = "DATABASE_ERROR",
  NOT_FOUND_ERROR = "NOT_FOUND_ERROR",
  RESOURCE_CONFLICT = "RESOURCE_CONFLICT",

  // Booking & Availability Errors
  AVAILABILITY_ERROR = "AVAILABILITY_ERROR",
  BOOKING_CONFLICT = "BOOKING_CONFLICT",
  SLOT_UNAVAILABLE = "SLOT_UNAVAILABLE",
  MAX_PARTICIPANTS_REACHED = "MAX_PARTICIPANTS_REACHED",

  // Rate Limiting
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",

  // Generic Errors
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

// Error response structure
export interface AppErrorResponse {
  error: string;
  errorType: AppErrorType;
  message: string;
  details?: any;
  timestamp: string;
  requestId?: string;
}

// Custom error class for better error handling
export class AppError extends Error {
  public readonly errorType: AppErrorType;
  public readonly statusCode: number;
  public readonly details?: any;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    errorType: AppErrorType,
    statusCode: number = 500,
    details?: any,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }
}

// Predefined error creators for common scenarios
export const AppErrors = {
  // Authentication & Authorization
  unauthorized: (message = "Authentication required") =>
    new AppError(message, AppErrorType.UNAUTHORIZED, 401),

  forbidden: (message = "Access denied") =>
    new AppError(message, AppErrorType.FORBIDDEN, 403),

  // Validation Errors
  validationError: (message: string, details?: any) =>
    new AppError(message, AppErrorType.VALIDATION_ERROR, 400, details),

  invalidInput: (message: string) =>
    new AppError(message, AppErrorType.INVALID_INPUT, 400),

  // Payment Errors
  paymentConfigError: (message = "Payment system configuration error") =>
    new AppError(message, AppErrorType.PAYMENT_CONFIG_ERROR, 500),

  paymentProcessingError: (message = "Payment processing failed") =>
    new AppError(message, AppErrorType.PAYMENT_PROCESSING_ERROR, 422),

  paymentVerificationFailed: (message = "Payment verification failed") =>
    new AppError(message, AppErrorType.PAYMENT_VERIFICATION_FAILED, 400),

  paymentAmountMismatch: (expected: number, received: number, currency: string) =>
    new AppError(
      `Payment amount mismatch: expected ${expected} ${currency}, got ${received} ${currency}`,
      AppErrorType.PAYMENT_AMOUNT_MISMATCH,
      400,
      { expected, received, currency }
    ),

  // Database & Resource Errors
  databaseError: (message = "Database operation failed") =>
    new AppError(message, AppErrorType.DATABASE_ERROR, 500),

  notFound: (resource: string, id?: string) =>
    new AppError(
      `${resource}${id ? ` with ID ${id}` : ""} not found`,
      AppErrorType.NOT_FOUND_ERROR,
      404,
      { resource, id }
    ),

  resourceConflict: (message: string) =>
    new AppError(message, AppErrorType.RESOURCE_CONFLICT, 409),

  // Booking & Availability Errors
  availabilityError: (message: string) =>
    new AppError(message, AppErrorType.AVAILABILITY_ERROR, 409),

  bookingConflict: (message = "Booking conflict detected") =>
    new AppError(message, AppErrorType.BOOKING_CONFLICT, 409),

  slotUnavailable: (message = "Selected time slot is not available") =>
    new AppError(message, AppErrorType.SLOT_UNAVAILABLE, 409),

  maxParticipantsReached: (eventType: string, maxParticipants: number) =>
    new AppError(
      `${eventType} is full (max ${maxParticipants} participants)`,
      AppErrorType.MAX_PARTICIPANTS_REACHED,
      409,
      { eventType, maxParticipants }
    ),

  // Rate Limiting
  rateLimitExceeded: (retryAfter: number) =>
    new AppError(
      `Rate limit exceeded. Retry after ${retryAfter} seconds`,
      AppErrorType.RATE_LIMIT_EXCEEDED,
      429,
      { retryAfter }
    ),

  // Generic Errors
  internalServerError: (message = "Internal server error") =>
    new AppError(message, AppErrorType.INTERNAL_SERVER_ERROR, 500),

  unknownError: (message = "An unknown error occurred") =>
    new AppError(message, AppErrorType.UNKNOWN_ERROR, 500),
};

// Error handler for API routes
export function handleApiError(error: unknown, requestId?: string): NextResponse {
  console.error("API Error:", error);

  // Handle our custom AppError
  if (error instanceof AppError) {
    const response: AppErrorResponse = {
      error: error.message,
      errorType: error.errorType,
      message: error.message,
      details: error.details,
      timestamp: new Date().toISOString(),
      requestId,
    };

    return NextResponse.json(response, { status: error.statusCode });
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const response: AppErrorResponse = {
      error: "Validation failed",
      errorType: AppErrorType.VALIDATION_ERROR,
      message: "Request validation failed",
      details: error.errors,
      timestamp: new Date().toISOString(),
      requestId,
    };

    return NextResponse.json(response, { status: 400 });
  }

  // Handle generic JavaScript errors
  if (error instanceof Error) {
    // Check for specific error patterns
    if (
      error.message.includes("Authentication failed") ||
      error.message.includes("Invalid API key")
    ) {
      return handleApiError(AppErrors.paymentConfigError(error.message), requestId);
    }

    if (
      error.message.includes("Prisma") ||
      error.message.includes("database")
    ) {
      return handleApiError(AppErrors.databaseError(error.message), requestId);
    }

    if (error.message.includes("not found")) {
      return handleApiError(AppErrors.notFound("Resource"), requestId);
    }

    if (
      error.message.includes("slot") ||
      error.message.includes("availability")
    ) {
      return handleApiError(AppErrors.availabilityError(error.message), requestId);
    }

    if (error.message.includes("Failed to create payment intent")) {
      return handleApiError(AppErrors.paymentProcessingError(error.message), requestId);
    }

    // Generic error fallback
    const response: AppErrorResponse = {
      error: error.message,
      errorType: AppErrorType.UNKNOWN_ERROR,
      message: error.message,
      timestamp: new Date().toISOString(),
      requestId,
    };

    return NextResponse.json(response, { status: 500 });
  }

  // Handle unknown error types
  const response: AppErrorResponse = {
    error: "An unknown error occurred",
    errorType: AppErrorType.UNKNOWN_ERROR,
    message: "An unexpected error occurred. Please try again.",
    timestamp: new Date().toISOString(),
    requestId,
  };

  return NextResponse.json(response, { status: 500 });
}

// Helper function to generate request IDs for better error tracking
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// Utility function to check if error is operational (safe to show to user)
export function isOperationalError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

// Error logging utility with different levels
export const ErrorLogger = {
  error: (message: string, error: unknown, context?: any) => {
    console.error(`[ERROR] ${message}`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context,
      timestamp: new Date().toISOString(),
    });
  },

  warn: (message: string, context?: any) => {
    console.warn(`[WARN] ${message}`, {
      context,
      timestamp: new Date().toISOString(),
    });
  },

  info: (message: string, context?: any) => {
    console.log(`[INFO] ${message}`, {
      context,
      timestamp: new Date().toISOString(),
    });
  },
};