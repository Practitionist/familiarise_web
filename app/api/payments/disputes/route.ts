/**
 * Disputes API
 * Handles dispute retrieval and evidence submission
 * Note: Disputes are primarily created via webhooks when payment gateways notify us
 */

import { listDisputes, submitDisputeEvidence } from "@/lib/payments";
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
// Validation Schemas
// ============================================================================

const submitEvidenceSchema = z.object({
  disputeId: z.string().min(1, "Dispute ID is required"),
  evidence: z.object({
    customerName: z.string().optional(),
    customerEmailAddress: z.string().email().optional(),
    customerPurchaseIp: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDisclosure: z.string().optional(),
    cancellationRebuttal: z.string().optional(),
    duplicateChargeId: z.string().optional(),
    duplicateChargeExplanation: z.string().optional(),
    duplicateChargeDocumentation: z.string().optional(),
    productDescription: z.string().optional(),
    receipt: z.string().optional(),
    customerCommunication: z.string().optional(),
    uncategorizedText: z.string().optional(),
    uncategorizedFile: z.string().optional(),
  }),
});

// ============================================================================
// GET /api/payments/disputes - List Disputes
// ============================================================================

// Shared disputes.manage gate for GET + POST (were 26 identical lines in
// each handler). Neither handler needs the db user row past the gate.
async function requireDisputesManager(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  // Authentication
  const session = await getSession(true);
  if (!session?.user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  // Admin/Staff check
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  // Submitting evidence pushes an irreversible decision to the payment
  // gateway, so it is `disputes.manage` (ADMIN) — not the `disputes.read`
  // that staff hold. The dashboard already told staff this
  // ("As a staff member… you cannot submit evidence") and hid the button;
  // the route contradicted its own UI and accepted the call anyway.
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
    const { error: authError } = await requireDisputesManager();
    if (authError) return authError;

    // Parse query params
    const searchParams = req.nextUrl.searchParams;
    const gateway = searchParams.get("gateway") as "STRIPE" | "RAZORPAY" | null;
    const limit = parseInt(searchParams.get("limit") || "10");

    if (gateway && gateway !== "STRIPE") {
      return NextResponse.json(
        {
          error:
            "Only Stripe supports direct dispute API. Razorpay disputes are webhook-only.",
        },
        { status: 400 },
      );
    }

    if (gateway === "STRIPE") {
      // Fetch from Stripe API
      const disputes = await listDisputes("STRIPE", limit);

      return NextResponse.json({
        disputes,
        gateway: "STRIPE",
        count: disputes.length,
      });
    } else {
      // List all disputes from database
      const disputes = await prisma.dispute.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          payment: {
            include: {
              user: { select: { id: true, email: true, name: true } },
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
    }
  } catch (error) {
    console.error("Disputes listing error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list disputes",
      },
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
  const peek: unknown = await req
    .clone()
    .json()
    .catch(() => null);
  if (peek && typeof peek === "object" && "action" in peek) {
    return contestRazorpay(req, { params: Promise.resolve({} as never) });
  }
  try {
    const { session, error: authError } = await requireDisputesManager();
    if (authError) return authError;

    // #677/PM-36 — evidence submission is an irreversible gateway push.
    const limited = await applyRateLimit(moneyOpsLimiter, session.user.id);
    if (limited) return limited;

    // Validate request
    const body = await req.json();
    const { disputeId: dbDisputeId, evidence } =
      submitEvidenceSchema.parse(body);

    // STEP 1: Get dispute and validate OUTSIDE transaction
    const dispute = await prisma.dispute.findUnique({
      where: { id: dbDisputeId },
      include: {
        payment: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    // Check if dispute can still accept evidence
    if (
      dispute.status === "WON" ||
      dispute.status === "LOST" ||
      dispute.status === "CHARGE_REFUNDED"
    ) {
      return NextResponse.json(
        { error: "Dispute is already resolved and cannot accept new evidence" },
        { status: 400 },
      );
    }

    // #677/PM-37 — enforce the evidence deadline LOCALLY. Late submissions
    // used to fail only inside Stripe, surfacing as an untyped 500 after the
    // operator had already composed the packet. A typed 410 up front lets
    // the dashboard say "deadline passed" instead of "something broke".
    if (
      evidenceDeadlinePassed({
        status: dispute.status,
        dueBy: dispute.dueBy,
        nowMs: Date.now(),
      })
    ) {
      return NextResponse.json(
        {
          error:
            "The evidence deadline for this dispute has passed. Contact payment-gateway support to resolve it manually.",
          code: "EVIDENCE_DEADLINE_PASSED",
          dueBy: dispute.dueBy?.toISOString() ?? null,
        },
        { status: 410 },
      );
    }

    // #1771 K-7 — Razorpay evidence has its own shape (action, summary, document ids).
    if (dispute.paymentGateway !== "STRIPE") {
      return NextResponse.json(
        {
          error:
            "Razorpay evidence is a summary plus uploaded documents — use the Razorpay evidence form.",
          code: "RAZORPAY_EVIDENCE_SHAPE",
        },
        { status: 400 },
      );
    }

    // STEP 2: Submit to Stripe OUTSIDE transaction
    // This prevents holding DB connections during potentially slow API calls
    const disputeResult = await submitDisputeEvidence(
      {
        disputeId: dispute.disputeId,
        evidence,
      },
      dispute.paymentGateway,
    );

    // STEP 3: Update database in a small, focused transaction
    await prisma.dispute.update({
      where: { disputeId: dispute.disputeId },
      data: {
        status: disputeResult.status,
        evidence: disputeResult.evidence as Prisma.InputJsonValue,
        // Stamped alongside the evidence itself so the two can never disagree.
        evidenceSubmittedAt: new Date(),
      },
    });

    const result = { dispute, disputeResult };

    return NextResponse.json({
      success: true,
      dispute: {
        id: result.dispute.id,
        disputeId: result.disputeResult.disputeId,
        status: result.disputeResult.status,
        isChargeRefundable: result.disputeResult.isChargeRefundable,
        dueBy: result.disputeResult.dueBy,
      },
      message: "Evidence submitted successfully",
    });
  } catch (error) {
    console.error("Evidence submission error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to submit evidence",
      },
      { status: 500 },
    );
  }
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
      const next = mapDisputeStatus(result.status);
      const now = new Date();
      const evidence = {
        gateway: "RAZORPAY",
        action: body.action,
        summary: body.summary,
        amountPaise: body.amountPaise ?? null,
        documents: body.evidence,
        savedAt: now.toISOString(),
      } as Prisma.InputJsonValue;
      const stamp = {
        evidence,
        ...(body.action === "submit" ? { evidenceSubmittedAt: now } : {}),
      };
      // The status moves only from the state we read; a webhook that got
      // there first keeps its word, and the evidence is stamped regardless.
      const moved =
        next &&
        next !== dispute.status &&
        isLegalDisputeTransition(dispute.status, next)
          ? await prisma.dispute.updateMany({
              where: { id: dispute.id, status: dispute.status },
              data: { ...stamp, status: next },
            })
          : { count: 0 };
      if (moved.count === 0) {
        await prisma.dispute.update({ where: { id: dispute.id }, data: stamp });
      }
      return {
        target: { kind: "Dispute", id: dispute.id },
        before: { status: dispute.status },
        after: { gatewayStatus: result.status, action: body.action },
        response: {
          success: true,
          gatewayStatus: result.status,
          message:
            body.action === "submit"
              ? "Evidence submitted to Razorpay"
              : "Draft saved on Razorpay",
        },
      };
    },
  },
);
