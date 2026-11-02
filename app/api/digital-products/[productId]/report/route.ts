/** POST /api/digital-products/[productId]/report — a signed-in user flags a product for review. */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, spamLimiter } from "@/lib/rate-limit";
import { reportDigitalProductSchema } from "@/schemas/digital-products";
import { jsonError, parseBody } from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const reporterId = auth.session.user.id;
  const limited = await applyRateLimit(spamLimiter, `dp-report:${reporterId}`);
  if (limited) return limited;
  const body = await parseBody(request, reportDigitalProductSchema);
  if (!body.ok) return body.error;

  const { productId } = await params;
  const product = await prisma.digitalProduct.count({
    where: { id: productId, status: { not: "DRAFT" } },
  });
  if (product === 0) return jsonError(404, "NOT_FOUND", "Product not found");

  const report = await prisma.digitalProductReport.create({
    data: { productId, reporterId, reason: body.data.reason },
    select: { id: true },
  });
  return NextResponse.json({ data: report }, { status: 201 });
}
