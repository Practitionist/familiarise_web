/**
 * Planner Services Index
 *
 * Re-exports all planner-related services for easier imports.
 * The PlannerService class in planner.ts acts as a facade for backward compatibility.
 */

// Shared utilities
export { TransactionContext } from "./transaction-context";
export { TopicService } from "./topic-service";

// Event services (webinars, classes)
export { WebinarService, ClassService } from "./events";

// Plan services (consultations, subscriptions)
export { ConsultationService, SubscriptionService } from "./plans";

// Re-export types
export * from "./types";

// Re-export the main PlannerService for backward compatibility
export { PlannerService } from "./planner";
