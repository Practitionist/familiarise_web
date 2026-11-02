/**
 * GET  /api/digital-products — the signed-in consultant's own products.
 * POST /api/digital-products — create a DRAFT product owned by their profile.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { createDigitalProductSchema } from "@/schemas/digital-products";
import {
  jsonError,
  parseBody,
  productSlug,
} from "@/lib/digital-products/creator";

export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const consultantProfileId = auth.session.user.consultantProfileId;
  if (!consultantProfileId) {
    return jsonError(403, "CONSULTANT_REQUIRED", "Only experts sell products");
  }
  const products = await prisma.digitalProduct.findMany({
    where: { consultantProfileId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      slug: true,
      category: true,
      pricePaise: true,
      status: true,
      takenDownAt: true,
      publishedAt: true,
      createdAt: true,
      _count: {
        select: {
          assets: { where: { status: "VERIFIED" } },
          purchases: { where: { status: "SUCCEEDED" } },
        },
      },
    },
  });
  return NextResponse.json({ data: products });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const consultantProfileId = auth.session.user.consultantProfileId;
  if (!consultantProfileId) {
    return jsonError(403, "CONSULTANT_REQUIRED", "Only experts sell products");
  }
  const body = await parseBody(request, createDigitalProductSchema);
  if (!body.ok) return body.error;

  try {
    const product = await prisma.digitalProduct.create({
      data: {
        ...body.data,
        consultantProfileId,
        slug: productSlug(body.data.title),
        status: "DRAFT",
      },
      select: { id: true, slug: true, status: true },
    });
    return NextResponse.json({ data: product }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return jsonError(409, "SLUG_TAKEN", "Please try again");
    }
    throw error;
  }
}
