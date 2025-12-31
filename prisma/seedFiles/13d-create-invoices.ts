import { faker } from "@faker-js/faker";
import { PaymentStatus, Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  generateInvoiceNumber,
  resetInvoiceSequence,
  calculateTaxBreakdown,
  GST_TAX_RATE,
  HSN_CODE_CONSULTING,
} from "./utils";

// Type for payment with appointment data
type PaymentWithAppointment = Prisma.PaymentGetPayload<{
  include: {
    appointment: {
      include: {
        consultation: {
          include: {
            consultationPlan: true;
          };
        };
        subscription: {
          include: {
            subscriptionPlan: true;
          };
        };
        webinar: {
          include: {
            webinarPlan: true;
          };
        };
        class: {
          include: {
            classPlan: true;
          };
        };
      };
    };
    user: true;
  };
}>;

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  hsnCode: string;
  taxRate: number;
  taxAmount: number;
}

/**
 * Build invoice line items from payment's appointment
 */
function buildInvoiceLineItems(
  payment: PaymentWithAppointment,
): InvoiceLineItem[] {
  const appointment = payment.appointment;
  if (!appointment) {
    return [createGenericLineItem(payment.amount, payment.description || "Service")];
  }

  let description = "Consulting Service";
  let planTitle = "";

  // Determine service type and get plan details
  if (appointment.consultation?.consultationPlan) {
    const plan = appointment.consultation.consultationPlan;
    planTitle = plan.title;
    description = `1:1 Consultation - ${planTitle}`;
  } else if (appointment.subscription?.subscriptionPlan) {
    const plan = appointment.subscription.subscriptionPlan;
    planTitle = plan.title;
    description = `Subscription Plan - ${planTitle}`;
  } else if (appointment.webinar?.webinarPlan) {
    const plan = appointment.webinar.webinarPlan;
    planTitle = plan.title;
    description = `Webinar - ${planTitle}`;
  } else if (appointment.class?.classPlan) {
    const plan = appointment.class.classPlan;
    planTitle = plan.title;
    description = `Class Program - ${planTitle}`;
  }

  return [createGenericLineItem(payment.amount, description)];
}

/**
 * Create a generic line item with tax breakdown
 */
function createGenericLineItem(totalAmount: number, description: string): InvoiceLineItem {
  const { baseAmount, taxAmount } = calculateTaxBreakdown(totalAmount);

  return {
    description,
    quantity: 1,
    unitPrice: baseAmount,
    amount: baseAmount,
    hsnCode: HSN_CODE_CONSULTING,
    taxRate: GST_TAX_RATE,
    taxAmount,
  };
}

/**
 * Generate a mock PDF URL for the invoice
 */
function generatePdfUrl(invoiceNumber: string): string {
  const sanitizedNumber = invoiceNumber.replace(/[^a-zA-Z0-9-]/g, "-");
  return `https://storage.familiarise.com/invoices/${sanitizedNumber}.pdf`;
}

export async function createInvoices(): Promise<void> {
  console.log("Creating invoices...");

  // Reset invoice sequence for consistent numbering
  resetInvoiceSequence();

  // Get SUCCEEDED payments without existing invoices, ordered by date for sequential numbering
  const succeededPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      invoice: null, // No existing invoice
    },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: true,
            },
          },
          subscription: {
            include: {
              subscriptionPlan: true,
            },
          },
          webinar: {
            include: {
              webinarPlan: true,
            },
          },
          class: {
            include: {
              classPlan: true,
            },
          },
        },
      },
      user: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  console.log(`Found ${succeededPayments.length} SUCCEEDED payments to invoice`);

  if (succeededPayments.length === 0) {
    console.log("No eligible payments found for invoice creation");
    return;
  }

  let created = 0;
  let failed = 0;

  for (const payment of succeededPayments) {
    try {
      const typedPayment = payment as PaymentWithAppointment;

      // Generate invoice number
      const invoiceNumber = generateInvoiceNumber(payment.createdAt);

      // Calculate tax breakdown
      const { baseAmount, taxAmount } = calculateTaxBreakdown(payment.amount);

      // Build line items
      const items = buildInvoiceLineItems(typedPayment);

      // Determine invoice status based on payment status
      const status = PaymentStatus.SUCCEEDED;

      await prisma.invoice.create({
        data: {
          paymentId: payment.id,
          invoiceNumber,
          amount: payment.amount,
          currency: payment.currency,
          status,
          items: items as unknown as Prisma.InputJsonValue,
          pdfUrl: generatePdfUrl(invoiceNumber),
          dueDate: payment.createdAt, // Due immediately for paid invoices
          paidAt: payment.createdAt, // Paid at payment time
          taxAmount,
          taxRate: GST_TAX_RATE,
          hsnCode: HSN_CODE_CONSULTING,
          createdAt: payment.createdAt,
        },
      });

      created++;
      if (created % 20 === 0) {
        console.log(`Created ${created} invoices...`);
      }
    } catch (error) {
      console.error(`Failed to create invoice for payment ${payment.id}:`, error);
      failed++;
    }
  }

  // Log summary
  console.log(`\nInvoices Summary:`);
  console.log(`  Created: ${created}`);
  console.log(`  Failed: ${failed}`);

  const totalAmounts = await prisma.invoice.aggregate({
    _sum: {
      amount: true,
      taxAmount: true,
    },
    _count: true,
  });

  console.log(`\nInvoice Totals:`);
  console.log(`  Total invoices: ${totalAmounts._count}`);
  console.log(
    `  Total amount: ${((totalAmounts._sum.amount || 0) / 100).toFixed(2)} INR`,
  );
  console.log(
    `  Total tax collected: ${((totalAmounts._sum.taxAmount || 0) / 100).toFixed(2)} INR`,
  );
}
