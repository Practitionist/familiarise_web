/**
 * Invoice Service
 * Generates GST-compliant invoices for payments
 */

import prisma from "@/lib/prisma";
import { PaymentStatus, Prisma } from "@prisma/client";
import { TAX_CONSTANTS } from "./constants";

// ============================================
// Types
// ============================================

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  hsnCode?: string;
}

export interface InvoiceData {
  invoiceNumber: string;
  paymentId: string;
  customerName: string;
  customerEmail: string;
  customerAddress?: string;
  customerGstin?: string;
  items: InvoiceItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  currency: string;
  status: PaymentStatus;
  issuedAt: Date;
  dueDate?: Date;
  paidAt?: Date;
  hsnCode: string;
  notes?: string;
}

export interface CreateInvoiceParams {
  paymentId: string;
  customerName: string;
  customerEmail: string;
  customerAddress?: string;
  customerGstin?: string;
  items: InvoiceItem[];
  notes?: string;
}

// ============================================
// Invoice Number Generation
// ============================================

/**
 * Generate unique invoice number
 * Format: FAM-YYYYMM-XXXXX (e.g., FAM-202501-00001)
 */
async function generateInvoiceNumber(): Promise<string> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `FAM-${yearMonth}`;

  // Get the latest invoice number for this month
  const latestInvoice = await prisma.invoice.findFirst({
    where: {
      invoiceNumber: { startsWith: prefix },
    },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });

  let sequence = 1;
  if (latestInvoice) {
    const lastSequence = parseInt(latestInvoice.invoiceNumber.split("-")[2], 10);
    sequence = lastSequence + 1;
  }

  return `${prefix}-${String(sequence).padStart(5, "0")}`;
}

// ============================================
// Invoice Creation
// ============================================

/**
 * Create invoice for a payment
 */
export async function createInvoice(
  params: CreateInvoiceParams
): Promise<InvoiceData> {
  const { paymentId, customerName, customerEmail, items, notes } = params;

  // Get payment details
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      appointment: {
        include: {
          consultation: { include: { consultationPlan: true } },
          subscription: { include: { subscriptionPlan: true } },
          webinar: { include: { webinarPlan: true } },
          class: { include: { classPlan: true } },
        },
      },
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  // Check if invoice already exists
  const existingInvoice = await prisma.invoice.findFirst({
    where: { paymentId },
  });

  if (existingInvoice) {
    throw new Error(`Invoice already exists for payment: ${paymentId}`);
  }

  // Calculate amounts
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const taxRate = TAX_CONSTANTS.GST_RATE;
  const taxAmount = Math.round((subtotal * taxRate) / 100);
  const total = subtotal + taxAmount;

  // Determine HSN code based on service type
  let hsnCode: string = TAX_CONSTANTS.HSN_CODES.CONSULTING;
  if (payment.appointment?.webinar || payment.appointment?.class) {
    hsnCode = TAX_CONSTANTS.HSN_CODES.EDUCATION;
  }

  // Generate invoice number
  const invoiceNumber = await generateInvoiceNumber();

  // Create invoice record
  const invoice = await prisma.invoice.create({
    data: {
      paymentId,
      invoiceNumber,
      amount: total,
      currency: payment.currency,
      status: payment.paymentStatus,
      items: items as unknown as Prisma.InputJsonValue,
      taxAmount,
      taxRate,
      hsnCode,
      paidAt: payment.paymentStatus === PaymentStatus.SUCCEEDED ? new Date() : null,
    },
  });

  return {
    invoiceNumber: invoice.invoiceNumber,
    paymentId,
    customerName,
    customerEmail,
    customerAddress: params.customerAddress,
    customerGstin: params.customerGstin,
    items,
    subtotal,
    taxRate,
    taxAmount,
    total,
    currency: payment.currency,
    status: payment.paymentStatus,
    issuedAt: invoice.createdAt,
    dueDate: invoice.dueDate || undefined,
    paidAt: invoice.paidAt || undefined,
    hsnCode,
    notes,
  };
}

/**
 * Auto-create invoice from payment
 * Called from payment success webhook
 */
export async function createInvoiceFromPayment(paymentId: string): Promise<string | null> {
  try {
    // Get payment with user details
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: true,
        appointment: {
          include: {
            consultation: { include: { consultationPlan: true } },
            subscription: { include: { subscriptionPlan: true } },
            webinar: { include: { webinarPlan: true } },
            class: { include: { classPlan: true } },
          },
        },
      },
    });

    if (!payment) {
      console.warn(`Payment not found for invoice creation: ${paymentId}`);
      return null;
    }

    // Check if invoice already exists
    const existingInvoice = await prisma.invoice.findFirst({
      where: { paymentId },
    });

    if (existingInvoice) {
      return existingInvoice.id;
    }

    // Build invoice items based on appointment type
    let description = "Consultation Service";
    let hsnCode: string = TAX_CONSTANTS.HSN_CODES.CONSULTING;

    if (payment.appointment?.consultation?.consultationPlan) {
      description = `Consultation: ${payment.appointment.consultation.consultationPlan.title || "Session"}`;
    } else if (payment.appointment?.subscription?.subscriptionPlan) {
      description = `Subscription: ${payment.appointment.subscription.subscriptionPlan.title || "Plan"}`;
    } else if (payment.appointment?.webinar?.webinarPlan) {
      description = `Webinar: ${payment.appointment.webinar.webinarPlan.title || "Session"}`;
      hsnCode = TAX_CONSTANTS.HSN_CODES.EDUCATION;
    } else if (payment.appointment?.class?.classPlan) {
      description = `Class: ${payment.appointment.class.classPlan.title || "Session"}`;
      hsnCode = TAX_CONSTANTS.HSN_CODES.EDUCATION;
    }

    // Calculate tax breakdown (assuming amount is inclusive of tax for display)
    const totalAmount = payment.amount;
    const taxRate = TAX_CONSTANTS.GST_RATE;
    // For GST-inclusive prices: baseAmount = total / (1 + rate/100)
    const baseAmount = Math.round((totalAmount * 100) / (100 + taxRate));
    const taxAmount = totalAmount - baseAmount;

    const items: InvoiceItem[] = [
      {
        description,
        quantity: 1,
        unitPrice: baseAmount,
        amount: baseAmount,
        hsnCode,
      },
    ];

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();

    // Create invoice
    const invoice = await prisma.invoice.create({
      data: {
        paymentId,
        invoiceNumber,
        amount: totalAmount,
        currency: payment.currency,
        status: payment.paymentStatus,
        items: items as unknown as Prisma.InputJsonValue,
        taxAmount,
        taxRate,
        hsnCode,
        paidAt: payment.paymentStatus === PaymentStatus.SUCCEEDED ? new Date() : null,
      },
    });

    console.log(`📄 Invoice ${invoiceNumber} created for payment ${paymentId}`);
    return invoice.id;
  } catch (error) {
    console.error(`Failed to create invoice for payment ${paymentId}:`, error);
    return null;
  }
}

// ============================================
// Invoice Retrieval
// ============================================

/**
 * Get invoice by ID
 */
export async function getInvoiceById(invoiceId: string) {
  return prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      payment: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
}

/**
 * Get invoice by invoice number
 */
export async function getInvoiceByNumber(invoiceNumber: string) {
  return prisma.invoice.findUnique({
    where: { invoiceNumber },
    include: {
      payment: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
}

/**
 * Get invoices for a user
 */
export async function getUserInvoices(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    status?: PaymentStatus;
  }
) {
  const { limit = 20, offset = 0, status } = options || {};

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        payment: { userId },
        ...(status ? { status } : {}),
      },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.invoice.count({
      where: {
        payment: { userId },
        ...(status ? { status } : {}),
      },
    }),
  ]);

  return {
    invoices,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Get all invoices (admin)
 */
export async function getAllInvoices(options?: {
  limit?: number;
  offset?: number;
  status?: PaymentStatus;
}) {
  const { limit = 50, offset = 0, status } = options || {};

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where: status ? { status } : {},
      include: {
        payment: {
          include: {
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.invoice.count({
      where: status ? { status } : {},
    }),
  ]);

  return {
    invoices,
    total,
    hasMore: offset + limit < total,
  };
}
