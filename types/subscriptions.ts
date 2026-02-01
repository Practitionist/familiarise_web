/**
 * Shared types for Subscription Management API responses.
 * Used by admin/subscriptions and staff/subscriptions pages.
 */

export interface SubscriptionListItem {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  gateway: string;
  userName: string;
  userEmail: string;
  consultantName: string | null;
  startDate: string | null;
  endDate: string | null;
  subscriptionStatus?: string | null;
  status: string;
  createdAt: string;
}

export interface SubscriptionListResponse {
  subscriptions: SubscriptionListItem[];
  stats: {
    activeCount: number;
    expiringCount: number;
    expiredCount: number;
  };
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
