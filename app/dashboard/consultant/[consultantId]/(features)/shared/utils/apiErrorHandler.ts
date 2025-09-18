/**
 * Centralized API error handling utilities
 * Standardizes error responses and logging across the application
 */

export interface StandardApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ApiErrorContext {
  operation: string;
  endpoint: string;
  parameters?: Record<string, any>;
  response?: {
    status: number;
    statusText: string;
    data?: any;
  };
}

/**
 * Standard error handler for API responses
 */
export class ApiErrorHandler {
  /**
   * Handle fetch response and standardize error format
   */
  static async handleFetchResponse<T>(
    response: Response,
    context: ApiErrorContext,
  ): Promise<StandardApiResponse<T>> {
    let data: any = null;
    
    // Try to parse JSON response
    try {
      data = await response.json();
    } catch (e) {
      console.warn(`[ApiErrorHandler] Non-JSON response for ${context.operation}:`, e);
    }

    if (!response.ok) {
      const errorContext = {
        ...context,
        response: {
          status: response.status,
          statusText: response.statusText,
          data,
        },
      };

      console.error(`[ApiErrorHandler] ${context.operation} failed:`, errorContext);

      return {
        success: false,
        error: this.extractErrorMessage(data, response.status, context.operation),
      };
    }

    return {
      success: true,
      data: data?.data || data,
    };
  }

  /**
   * Handle network/fetch errors
   */
  static handleNetworkError(
    error: unknown,
    context: ApiErrorContext,
  ): StandardApiResponse {
    console.error(`[ApiErrorHandler] Network error for ${context.operation}:`, {
      ...context,
      error,
    });

    const errorMessage = error instanceof Error 
      ? error.message 
      : "Network error occurred";

    return {
      success: false,
      error: `${context.operation} failed: ${errorMessage}`,
    };
  }

  /**
   * Wrapper for API calls with standardized error handling
   */
  static async executeApiCall<T>(
    apiCall: () => Promise<Response>,
    context: ApiErrorContext,
  ): Promise<StandardApiResponse<T>> {
    try {
      const response = await apiCall();
      return await this.handleFetchResponse<T>(response, context);
    } catch (error) {
      return this.handleNetworkError(error, context);
    }
  }

  /**
   * Extract user-friendly error message from API response
   */
  private static extractErrorMessage(
    data: any,
    status: number,
    operation: string,
  ): string {
    // Try to get error from response data
    if (data?.error) {
      return data.error;
    }

    // Handle string responses
    if (typeof data === "string" && data.length > 0) {
      return data;
    }

    // Handle specific HTTP status codes
    switch (status) {
      case 400:
        return `Invalid request for ${operation}`;
      case 401:
        return "Authentication required";
      case 403:
        return "Access denied";
      case 404:
        return "Resource not found";
      case 409:
        return "Conflict - resource already exists or is in use";
      case 422:
        return "Invalid data provided";
      case 429:
        return "Too many requests - please try again later";
      case 500:
        return "Server error occurred";
      case 503:
        return "Service temporarily unavailable";
      default:
        return `${operation} failed (HTTP ${status})`;
    }
  }

  /**
   * Validate required parameters before API call
   */
  static validateRequired(params: Record<string, any>): void {
    const missing = Object.entries(params)
      .filter(([key, value]) => value == null || value === "")
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing required parameters: ${missing.join(", ")}`);
    }
  }

  /**
   * Create standardized request context
   */
  static createContext(
    operation: string,
    endpoint: string,
    parameters?: Record<string, any>,
  ): ApiErrorContext {
    return {
      operation,
      endpoint,
      parameters,
    };
  }
}