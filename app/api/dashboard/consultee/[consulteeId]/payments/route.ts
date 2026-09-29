import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import {
  readConsulteeMoneySummary,
  readConsulteePayments,
  type PaymentHistoryFilter,
  type PaymentHistoryRange,
} from "@/lib/data/consultee-payments";

/**
 * The consultee's own payment history. Auth and `?orgScope=` resolution live
 * here; the rows come from `readConsulteePayments`, the same read the RSC
 * page seeds with (#1675 X1). `?page=&status=&range=` page and filter the
 * history (#1527); `?view=summary` answers Home's two "This month" facts.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;
    const { searchParams } = new URL(request.url);

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own payment history");
    }

    if (!consulteeId) {
      return NextResponse.json(
        { error: "Consultee ID is required" },
        { status: 400 },
      );
    }

    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    if (searchParams.get("view") === "summary") {
      const summary = await readConsulteeMoneySummary({
        consulteeId,
        userId: consulteeProfile.userId,
      });
      return NextResponse.json(
        { data: summary, success: true },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    // #674 org-scope filter: an Acme + Zeta consultee's history splits per org
    // context; personal scope = the untagged rows.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped consultee endpoint.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }

    const data = await readConsulteePayments({
      consulteeId,
      userId: consulteeProfile.userId,
      orgScope: scopeResolution.scope,
      // Validated inside the read; unknown values fall back to the defaults.
      query: {
        page: Number(searchParams.get("page") ?? 1),
        pageSize: Number(searchParams.get("pageSize") ?? Number.NaN),
        status: searchParams.get("status") as PaymentHistoryFilter | null,
        range: searchParams.get("range") as PaymentHistoryRange | null,
      },
    });

    // Money truth is never cached (finance doctrine); PR #1755 swaps this
    // inline header for the shared constant.
    return NextResponse.json(
      { data, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching consultee payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 },
    );
  }
}
