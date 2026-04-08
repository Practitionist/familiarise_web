/**
 * Shared utilities for admin + staff ("operator") API routes.
 *
 * The goal is one source of truth for queries and aggregations that power
 * both the admin dashboard and the staff dashboard. Historically these
 * lived as duplicated code across ~13 route file pairs; see the canonical
 * enterprise design doc's follow-up section for the full migration plan.
 *
 * Current migrations:
 *   - [x] getOperatorDashboardStats  ← used by /api/admin/stats, /api/staff/stats
 *   - [ ] getOperatorPayments        ← TODO: unify /api/admin/payments, /api/staff/payments
 *   - [ ] getOperatorInvoices        ← TODO: unify /api/admin/invoices, /api/staff/invoices
 *   - [ ] getOperatorVerificationQueue ← TODO: /api/admin/verification, /api/staff/moderation/profiles
 *   - [ ] getOperatorDisputes        ← TODO
 *   - [ ] getOperatorFeedback        ← TODO
 *   - [ ] getOperatorSupportTickets  ← TODO
 *
 * The route handlers remain thin shells that call these utilities after
 * running the appropriate auth helper (`requirePrivilegedAuth` or
 * `requireAdminAuth`).
 */

export { getOperatorDashboardStats } from "./stats";
export type { OperatorDashboardStats } from "./stats";
