// Type for API responses
export type ApiResponse<T> = {
  data: T;
  error?: string;
  message?: string;
  count?: number;
  consultant?: string;
  appointmentTitle?: string;
  consultantName?: string;
  filters?: {
    status?: string;
    appointmentType?: string;
  };
  metadata?: {
    pendingCount?: number;
    reviewingCount?: number;
    completedCount?: number;
  };
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};
