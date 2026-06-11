/**
 * Shared types for Support Ticket API responses.
 * Used by admin/tickets, staff/tickets pages and their API routes.
 */

interface TicketUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  phone?: string | null;
}

export interface TicketResponse {
  id: string;
  message: string;
  isInternal: boolean;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    role: string | null;
    image: string | null;
  } | null;
}

interface TicketAttachment {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  uploadedAt: string;
}

interface LinkedConsultation {
  id: string;
  requestStatus: string;
  consultationPlan: {
    title: string;
    price: number;
    priceCurrency: string;
    consultantProfile: {
      user: { name: string | null; email: string | null };
    };
  };
  appointment: {
    id: string;
    scheduledAt: string;
    status: string;
  } | null;
}

interface LinkedPayment {
  id: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentGateway: string;
  createdAt: string;
}

interface LinkedRefund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED";
  category: string | null;
  issueType: string | null;
  user: TicketUser;
  assignedToId?: string | null;
  responseCount?: number;
  attachmentCount?: number;
  consultationId?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  createdAt: string;
  updatedAt: string;
  responses?: TicketResponse[];
  attachments?: TicketAttachment[];
  linkedConsultation?: LinkedConsultation | null;
  linkedSubscription?: LinkedConsultation | null;
  linkedPayment?: LinkedPayment | null;
  linkedRefund?: LinkedRefund | null;
}

export interface TicketCounts {
  total: number;
  open: number;
  inProgress: number;
  onHold: number;
  resolved: number;
  closed: number;
}

export interface TicketListResponse {
  tickets: Ticket[];
  counts: TicketCounts;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
}
