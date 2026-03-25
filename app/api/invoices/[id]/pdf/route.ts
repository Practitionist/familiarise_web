/**
 * Invoice PDF Download API
 * GET /api/invoices/[id]/pdf
 * Generates and returns a GST-compliant PDF invoice
 * Caches generated PDFs in Supabase Storage for repeat downloads
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  generateInvoicePdf,
  getInvoicePdfData,
} from "@/lib/payments/payouts/invoice-pdf";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Fetch invoice with payment + user data
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [{ id }, { invoiceNumber: id }],
      },
      include: {
        payment: {
          include: {
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    if (!invoice) {
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 },
      );
    }

    // Authorization: user must own the payment, or be admin/staff
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true, email: true },
    });

    const isOwner = invoice.payment?.user?.email === user?.email;
    const isAdmin = user?.role === "ADMIN" || user?.role === "STAFF";

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // If we already have a cached PDF URL, redirect to it
    if (invoice.pdfUrl) {
      return NextResponse.redirect(invoice.pdfUrl);
    }

    // Build PDF data from invoice record
    const pdfData = await getInvoicePdfData(invoice);

    // Generate PDF buffer
    const pdfBuffer = await generateInvoicePdf(pdfData);

    // Try to upload to Supabase Storage for caching (fire-and-forget)
    uploadToStorage(invoice.id, invoice.invoiceNumber, pdfBuffer).catch(
      (err) => {
        console.error(
          `Failed to cache PDF for invoice ${invoice.id}:`,
          err,
        );
      },
    );

    // Return PDF response
    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoice.invoiceNumber}.pdf"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error generating invoice PDF:", error);
    return NextResponse.json(
      { error: "Failed to generate invoice PDF" },
      { status: 500 },
    );
  }
}

/**
 * Upload generated PDF to Supabase Storage and update Invoice.pdfUrl
 * Best-effort — failures are logged but don't block the response
 */
async function uploadToStorage(
  invoiceId: string,
  invoiceNumber: string,
  pdfBuffer: Buffer,
): Promise<void> {
  // Dynamic import to avoid breaking if supabase isn't configured
  let supabase;
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.warn(
        "[invoice-pdf] Supabase credentials not configured, skipping PDF caching",
      );
      return;
    }

    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  } catch {
    return; // Supabase not available
  }

  const bucketName = "invoices";
  const filePath = `${invoiceId}/${invoiceNumber}.pdf`;

  // Ensure bucket exists (create if missing)
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find((b: { name: string }) => b.name === bucketName)) {
    await supabase.storage.createBucket(bucketName, { public: false });
  }

  // Upload PDF
  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(filePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error(`[invoice-pdf] Upload failed: ${uploadError.message}`);
    return;
  }

  // Get signed URL (1 year expiry)
  const { data: urlData } = await supabase.storage
    .from(bucketName)
    .createSignedUrl(filePath, 60 * 60 * 24 * 365);

  if (urlData?.signedUrl) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { pdfUrl: urlData.signedUrl },
    });
  }
}
