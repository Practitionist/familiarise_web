/**
 * Disputes API
 * Handles dispute retrieval and evidence submission
 * Note: Disputes are primarily created via webhooks when payment gateways notify us
 */

import { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import {
  evidenceDeadlinePassed,
  isLegalDisputeTransition,
  mapDisputeStatus,
} from "@/lib/payments/dispute-status";
import {
  contestDispute,
  DISPUTE_EVIDENCE_MIME_TYPES,
  RazorpayDisputeError,
  SUMMARY_MAX_CHARS,
  uploadDisputeDocument,
} from "@/lib/payments/core/razorpay-disputes";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { reportSentryError } from "@/lib/observability/report";
import { Prisma, type DisputeStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import type { Session } from "@/lib/auth";
import * as Sentry from "@sentry/nextjs";
// ============================================================================
// GET /api/payments/disputes - List Disputes
// ============================================================================

async function requireDisputesReader(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const session = await getSession(true);
  if (!session?.user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  if (!user?.role || !hasBackofficePermission(user.role, "disputes.read")) {
    return {
      error: NextResponse.json(
        { error: "Forbidden - Staff or Admin access required" },
        { status: 403 },
      ),
    };
  }
  return { session };
}

async function requireDisputesManager(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const session = await getSession(true);
  if (!session?.user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  if (!user?.role || !hasBackofficePermission(user.role, "disputes.manage")) {
    return {
      error: NextResponse.json(
        { error: "Forbidden - Admin access required" },
        { status: 403 },
      ),
    };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  try {
    const { session, error: authError } = await requireDisputesReader();
    if (authError) return authError;

    const parsedLimit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .safeParse(req.nextUrl.searchParams.get("limit") ?? undefined);
    if (!parsedLimit.success) {
      return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
    }
    const limit = parsedLimit.data;

    const callerRole = z.nativeEnum(UserRole).safeParse(session.user.role);
    const canManageDisputes =
      callerRole.success &&
      hasBackofficePermission(callerRole.data, "disputes.manage");

    const disputes = await prisma.dispute.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        payment: {
          include: {
            user: {
              select: {
                id: true,
                ...(canManageDisputes ? { email: true } : {}),
                name: true,
              },
            },
            appointment: { select: { id: true, appointmentType: true } },
          },
        },
      },
    });

    return NextResponse.json({
      disputes: disputes.map((d) => ({
        id: d.id,
        disputeId: d.disputeId,
        amount: d.amountPaise,
        currency: d.currency,
        status: d.status,
        reason: d.reason,
        gateway: d.paymentGateway,
        dueBy: d.dueBy,
        isChargeRefundable: d.isChargeRefundable,
        createdAt: d.createdAt,
        payment: {
          id: d.payment.id,
          amount: d.payment.amount,
          user: d.payment.user,
          appointment: d.payment.appointment,
        },
      })),
      count: disputes.length,
    });
  } catch (error) {
    console.error("Disputes listing error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );

    return NextResponse.json(
      { error: "Failed to list disputes" },
      { status: 500 },
    );
  }
}

// ============================================================================
// POST /api/payments/disputes - Submit Evidence
// ============================================================================

export async function POST(req: NextRequest) {
  // #1771 K-7 — Razorpay evidence: a file upload, or a draft/submit contest.
  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return uploadRazorpayEvidence(req);
  }
  return contestRazorpay(req, { params: Promise.resolve({}) });
}

// ============================================================================
// #1771 K-7 — Razorpay evidence (verified against razorpay.com/docs/api)
// ============================================================================

/** Netlify buffers at most 6 MB per request; leave room for the envelope. */
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

type EvidenceDispute = {
  id: string;
  disputeId: string;
  status: DisputeStatus;
  paymentGateway: string;
  dueBy: Date | null;
};

/** Razorpay takes evidence only on an `open` dispute, before its deadline. */
async function openRazorpayDispute(id: string): Promise<EvidenceDispute> {
  const dispute = await prisma.dispute.findUnique({
    where: { id },
    select: {
      id: true,
      disputeId: true,
      status: true,
      paymentGateway: true,
      dueBy: true,
    },
  });
  if (!dispute) {
    throw new OpsRefusal("DISPUTE_NOT_FOUND", "Dispute not found.", 404);
  }
  if (dispute.paymentGateway !== "RAZORPAY") {
    throw new OpsRefusal(
      "NOT_RAZORPAY",
      "This form contests Razorpay disputes only.",
      400,
    );
  }
  if (
    evidenceDeadlinePassed({
      status: dispute.status,
      dueBy: dispute.dueBy,
      nowMs: Date.now(),
    })
  ) {
    throw new OpsRefusal(
      "EVIDENCE_DEADLINE_PASSED",
      "The evidence deadline for this dispute has passed.",
      410,
    );
  }
  if (dispute.status !== "NEEDS_RESPONSE") {
    throw new OpsRefusal(
      "DISPUTE_NOT_OPEN",
      "Razorpay only takes evidence on an open dispute.",
    );
  }
  return dispute;
}

/** A gateway refusal keeps its own code; a gateway fault also pages. */
function gatewayRefusal(err: unknown): unknown {
  if (!(err instanceof RazorpayDisputeError)) return err;
  if (err.httpStatus >= 500) {
    reportSentryError(err, { subsystem: "payments", op: "razorpay-dispute" });
  }
  return new OpsRefusal(err.code, err.message, err.httpStatus);
}

async function uploadRazorpayEvidence(req: NextRequest) {
  const { session, error } = await requireDisputesManager();
  if (error) return error;
  const limited = await applyRateLimit(moneyOpsLimiter, session.user.id);
  if (limited) return limited;
  try {
    const form = await req.formData();
    const disputeId = form.get("disputeId");
    const file = form.get("file");
    if (typeof disputeId !== "string" || !(file instanceof Blob)) {
      throw new OpsRefusal("INVALID_BODY", "Send a disputeId and a file.", 400);
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new OpsRefusal(
        "EVIDENCE_TOO_LARGE",
        "Each file must be 4 MB or smaller here — split or compress it.",
        413,
      );
    }
    if (
      !(DISPUTE_EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)
    ) {
      throw new OpsRefusal(
        "EVIDENCE_TYPE_NOT_ALLOWED",
        "Evidence must be a JPG, PNG or PDF file.",
        400,
      );
    }
    await openRazorpayDispute(disputeId);
    const name = file instanceof File ? file.name : "evidence";
    const doc = await uploadDisputeDocument(file, file.type, name).catch(
      (err: unknown) => {
        throw gatewayRefusal(err);
      },
    );
    return NextResponse.json({ documentId: doc.id, name, size: file.size });
  } catch (err) {
    if (err instanceof OpsRefusal) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    reportSentryError(err, { subsystem: "payments", op: "dispute-upload" });
    return NextResponse.json(
      { error: "The upload failed — please try again.", code: "FAILED" },
      { status: 500 },
    );
  }
}

/**
 * Records a contest Razorpay already accepted. A local write failure pages and
 * answers false, never a retry prompt: Razorpay's state has moved (PR #1824).
 */
async function stampContest(
  dispute: EvidenceDispute,
  body: {
    action: "draft" | "submit";
    summary: string;
    amountPaise?: number;
    evidence: unknown;
  },
  gatewayStatus: string,
): Promise<boolean> {
  const now = new Date();
  const next = mapDisputeStatus(gatewayStatus);
  const stamp = {
    evidence: {
      gateway: "RAZORPAY",
      action: body.action,
      summary: body.summary,
      amountPaise: body.amountPaise ?? null,
      documents: body.evidence,
      savedAt: now.toISOString(),
    } as Prisma.InputJsonValue,
    ...(body.action === "submit" ? { evidenceSubmittedAt: now } : {}),
  };
  try {
    // The status moves only from the state we read; a webhook that got
    // there first keeps its word, and the evidence is stamped regardless.
    const moves =
      !!next &&
      next !== dispute.status &&
      isLegalDisputeTransition(dispute.status, next);
    const moved = moves
      ? await prisma.dispute.updateMany({
          where: { id: dispute.id, status: dispute.status },
          data: { ...stamp, status: next },
        })
      : { count: 0 };
    if (moved.count === 0) {
      await prisma.dispute.update({ where: { id: dispute.id }, data: stamp });
    }
    return true;
  } catch (err) {
    reportSentryError(err, {
      subsystem: "payments",
      op: "dispute-contest-stamp",
      extra: { disputeId: dispute.id, action: body.action, gatewayStatus },
    });
    return false;
  }
}

const docIds = z
  .array(z.string().regex(/^doc_\w+$/))
  .max(20)
  .optional();

const contestRazorpay = withOpsAction(
  "disputes.manage",
  (body) => `dispute.${body.action}`,
  {
    disputeId: z.string().min(1),
    action: z.enum(["draft", "submit"]),
    summary: z.string().trim().min(1).max(SUMMARY_MAX_CHARS),
    amountPaise: z.number().int().positive().optional(),
    evidence: z.object({
      proof_of_service: docIds,
      customer_communication: docIds,
      refund_cancellation_policy: docIds,
      term_and_conditions: docIds,
      explanation_letter: docIds,
      others: z
        .array(
          z.object({
            type: z.string().trim().min(1).max(100),
            document_ids: z.array(z.string().regex(/^doc_\w+$/)).min(1),
          }),
        )
        .max(10)
        .optional(),
    }),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Dispute", id: body.disputeId }),
    run: async ({ body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const dispute = await openRazorpayDispute(body.disputeId);
      const result = await contestDispute(dispute.disputeId, {
        action: body.action,
        amountPaise: body.amountPaise,
        summary: body.summary,
        evidence: body.evidence,
      }).catch((err: unknown) => {
        throw gatewayRefusal(err);
      });
      const stamped = await stampContest(dispute, body, result.status);
      return {
        target: { kind: "Dispute", id: dispute.id },
        before: { status: dispute.status },
        after: {
          gatewayStatus: result.status,
          action: body.action,
          localStampFailed: !stamped,
        },
        response: {
          success: true,
          gatewayStatus: result.status,
          localStampFailed: !stamped,
          message:
            body.action === "submit"
              ? "Evidence submitted to Razorpay"
              : "Draft saved on Razorpay",
        },
      };
    },
  },
);
