/**
 * Production-ready logging utility for Stream operations
 * Provides conditional logging based on environment and structured output
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  userId?: string;
  channelId?: string;
  operation?: string;
  duration?: number;
  [key: string]: unknown;
}

const isDevelopment = process.env.NODE_ENV === "development";
const isTest = process.env.NODE_ENV === "test";

// Enable verbose logging only in development
const VERBOSE_LOGGING = isDevelopment && !isTest;

/**
 * Format a log message with optional context
 */
function formatMessage(
  prefix: string,
  message: string,
  context?: LogContext,
): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : "";
  return `[${timestamp}] [${prefix}] ${message}${contextStr}`;
}

/**
 * Stream-specific logger with environment-aware output
 */
export const streamLogger = {
  /**
   * Debug level - only logs in development
   */
  debug(message: string, context?: LogContext): void {
    if (VERBOSE_LOGGING) {
      console.log(formatMessage("Stream:DEBUG", message, context));
    }
  },

  /**
   * Info level - logs in development, minimal in production
   */
  info(message: string, context?: LogContext): void {
    if (isDevelopment) {
      console.log(formatMessage("Stream:INFO", message, context));
    }
    // In production, could send to monitoring service
  },

  /**
   * Warning level - always logs
   */
  warn(message: string, context?: LogContext): void {
    console.warn(formatMessage("Stream:WARN", message, context));
  },

  /**
   * Error level - always logs with full details
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorContext = {
      ...context,
      error:
        error instanceof Error
          ? {
              message: error.message,
              name: error.name,
              ...(isDevelopment && { stack: error.stack }),
            }
          : error,
    };
    console.error(formatMessage("Stream:ERROR", message, errorContext));

    // In production, could send to error tracking service (Sentry, etc.)
    if (!isDevelopment && error instanceof Error) {
      // Example: Sentry.captureException(error, { extra: context });
    }
  },

  /**
   * Log operation timing (useful for performance monitoring)
   */
  timing(operation: string, durationMs: number, context?: LogContext): void {
    const level: LogLevel = durationMs > 5000 ? "warn" : "debug";
    const message = `${operation} completed in ${durationMs}ms`;

    if (level === "warn") {
      this.warn(message, { ...context, duration: durationMs, operation });
    } else {
      this.debug(message, { ...context, duration: durationMs, operation });
    }
  },

  /**
   * Log API call (for tracking Stream API usage)
   */
  apiCall(
    method: string,
    endpoint: string,
    success: boolean,
    context?: LogContext,
  ): void {
    const message = `API ${method} ${endpoint} - ${success ? "SUCCESS" : "FAILED"}`;
    if (success) {
      this.debug(message, context);
    } else {
      this.warn(message, context);
    }
  },
};

/**
 * Create a scoped logger with preset context
 */
export function createScopedLogger(scope: string, defaultContext?: LogContext) {
  return {
    debug(message: string, context?: LogContext): void {
      streamLogger.debug(`[${scope}] ${message}`, {
        ...defaultContext,
        ...context,
      });
    },
    info(message: string, context?: LogContext): void {
      streamLogger.info(`[${scope}] ${message}`, {
        ...defaultContext,
        ...context,
      });
    },
    warn(message: string, context?: LogContext): void {
      streamLogger.warn(`[${scope}] ${message}`, {
        ...defaultContext,
        ...context,
      });
    },
    error(
      message: string,
      error?: Error | unknown,
      context?: LogContext,
    ): void {
      streamLogger.error(`[${scope}] ${message}`, error, {
        ...defaultContext,
        ...context,
      });
    },
  };
}

/**
 * Measure and log execution time of an async function
 */
export async function withTiming<T>(
  operation: string,
  fn: () => Promise<T>,
  context?: LogContext,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    streamLogger.timing(operation, Date.now() - start, {
      ...context,
      success: true,
    });
    return result;
  } catch (error) {
    streamLogger.timing(operation, Date.now() - start, {
      ...context,
      success: false,
    });
    throw error;
  }
}

export default streamLogger;
