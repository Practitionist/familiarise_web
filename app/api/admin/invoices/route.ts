import { NextRequest, NextResponse } from "next/server";
import { OrgInvoiceStatus, type Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const VALID_B2B_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(OrgInvoiceStatus),
);

function parsePagination(sp: URLSearchParams) {
  const rawPage = Number.parseInt(sp.get("page") ?? "1", 10);
  const rawLimit = Number.parseInt(sp.get("limit") ?? "25", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 100) : 25;
  return { page, limit, skip: (page - 1) * limit };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("invoices.read");
    if (auth.error) return auth.error;

    const sp = request.nextUrl.searchParams;
    const scope = sp.get("scope") ?? sp.get("tab") ?? "b2b";
    const q = sp.get("q")?.trim() ?? sp.get("search")?.trim() ?? "";
    const statusParam = sp.get("status")?.trim() ?? "";
    const showPii = auth.session.user.role === "ADMIN";
    const { page, limit, skip } = parsePagination(sp);

    if (scope === "b2c") {
      const andConditions: Prisma.ConsumerInvoiceWhereInput[] = [];

      if (q) {
        andConditions.push({
          OR: [
            { invoiceNumber: { contains: q, mode: "insensitive" } },
            { buyerName: { contains: q, mode: "insensitive" } },
            { buyerEmail: { contains: q, mode: "insensitive" } },
            { paymentId: { contains: q, mode: "insensitive" } },
            { userId: { contains: q, mode: "insensitive" } },
          ],
        });
      }

      if (statusParam === "CREDIT_NOTED") {
        andConditions.push({ creditNotes: { some: {} } });
      } else if (statusParam === "ISSUED") {
        andConditions.push({ creditNotes: { none: {} } });
      }

      const where: Prisma.ConsumerInvoiceWhereInput =
        andConditions.length > 0 ? { AND: andConditions } : {};

      const [rows, total, agg, creditNotedCount] = await Promise.all([
        prisma.consumerInvoice.findMany({
          where,
          include: {
            creditNotes: {
              select: {
                id: true,
                creditNoteNumber: true,
                totalPaise: true,
              },
            },
          },
          orderBy: { issuedAt: "desc" },
          skip,
          take: limit,
        }),
        prisma.consumerInvoice.count({ where }),
        prisma.consumerInvoice.aggregate({
          where,
          _sum: {
            taxableValuePaise: true,
            cgstPaise: true,
            sgstPaise: true,
            igstPaise: true,
            totalPaise: true,
          },
        }),
        prisma.consumerInvoice.count({
          where: { ...where, creditNotes: { some: {} } },
        }),
      ]);

      const invoices = rows.map((inv) => ({
        id: inv.id,
        paymentId: inv.paymentId,
        userId: inv.userId,
        invoiceNumber: inv.invoiceNumber,
        buyerName: inv.buyerName,
        buyerEmail: showPii ? inv.buyerEmail : null,
        placeOfSupply: inv.placeOfSupply,
        taxableValuePaise: Number(inv.taxableValuePaise),
        cgstPaise: Number(inv.cgstPaise),
        sgstPaise: Number(inv.sgstPaise),
        igstPaise: Number(inv.igstPaise),
        totalPaise: Number(inv.totalPaise),
        currency: inv.currency,
        issuedAt: inv.issuedAt,
        status: inv.creditNotes.length > 0 ? "CREDIT_NOTED" : "ISSUED",
        creditNoteNumber: inv.creditNotes[0]?.creditNoteNumber ?? null,
        pdfUrl: `/api/payments/${inv.paymentId}/invoice/pdf`,
      }));

      return NextResponse.json({
        scope: "b2c",
        invoices,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        summary: {
          totalInvoices: total,
          issuedCount: Math.max(0, total - creditNotedCount),
          creditNotedCount,
          totalValuePaise: Number(agg._sum.totalPaise ?? 0),
          taxableValuePaise: Number(agg._sum.taxableValuePaise ?? 0),
        },
      });
    }

    const andConditions: Prisma.OrganizationInvoiceWhereInput[] = [];
    if (q) {
      andConditions.push({
        OR: [
          { invoiceNumber: { contains: q, mode: "insensitive" } },
          { id: { contains: q, mode: "insensitive" } },
          { gstin: { contains: q, mode: "insensitive" } },
          { organization: { name: { contains: q, mode: "insensitive" } } },
          {
            organization: {
              taxInfo: { legalName: { contains: q, mode: "insensitive" } },
            },
          },
        ],
      });
    }

    if (
      statusParam &&
      statusParam !== "ALL" &&
      VALID_B2B_STATUSES.has(statusParam)
    ) {
      andConditions.push({ status: statusParam as OrgInvoiceStatus });
    }

    const where: Prisma.OrganizationInvoiceWhereInput =
      andConditions.length > 0 ? { AND: andConditions } : {};

    const [rawInvoices, total, statusAggs] = await Promise.all([
      prisma.organizationInvoice.findMany({
        where,
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              paymentTermsDays: true,
              taxInfo: {
                select: {
                  legalName: true,
                },
              },
            },
          },
          billingAccount: {
            select: {
              id: true,
              fundingSource: true,
              billingEmail: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.organizationInvoice.count({ where }),
      prisma.organizationInvoice.groupBy({
        by: ["status"],
        where,
        _sum: { totalPaise: true },
        _count: true,
      }),
    ]);

    const invoices = rawInvoices.map((inv) => ({
      ...inv,
      organization: {
        id: inv.organization.id,
        name: inv.organization.name,
        slug: inv.organization.slug,
        legalName: showPii
          ? (inv.organization.taxInfo?.legalName ?? null)
          : undefined,
      },
      billingAccount: {
        id: inv.billingAccount.id,
        billingType: inv.billingAccount.fundingSource,
        paymentTermDays: inv.organization.paymentTermsDays ?? null,
      },
    }));

    const summary = {
      totalPaidPaise: 0,
      totalIssuedPaise: 0,
      totalOverduePaise: 0,
      counts: {} as Record<string, number>,
    };
    for (const row of statusAggs) {
      summary.counts[row.status] = row._count;
      const sum = Number(row._sum.totalPaise ?? 0);
      if (row.status === "PAID") summary.totalPaidPaise = sum;
      if (row.status === "ISSUED") summary.totalIssuedPaise = sum;
      if (row.status === "OVERDUE") summary.totalOverduePaise = sum;
    }

    return NextResponse.json({
      scope: "b2b",
      invoices,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary,
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 },
    );
  }
}
