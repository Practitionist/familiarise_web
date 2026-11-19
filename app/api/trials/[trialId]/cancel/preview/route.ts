import { NextResponse } from "next/server";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { reportSentryError } from "@/lib/observability/report";
import { creditStillUsedPaise } from "@/lib/payments/operations/credit-plan-return";
import prisma from "@/lib/prisma";
import {
  quoteTrialRefund,
  trialCancelWindowRefusal,
} from "@/lib/trials/cancellation";

// A money read: never cached (repo rule for money GETs).
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * GET /api/trials/[trialId]/cancel/preview
 *
 * #1846 — what cancelling this trial right now pays back, computed and never
 * written. The shape matches the appointment cancel preview (refund %, amount,
 * currency, rail) plus the paid amount for the breakdown line, so the same
 * dialog renders both. Trial DELETE then refunds only the amount confirmed from
 * this quote. `{ paid: false }` means there is nothing to refund.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ trialId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    const { trialId } = await params;

    // The same ownership scope as trial DELETE, so the preview never answers
    // where the cancel would 404.
    const trial = await prisma.trial.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
      select: {
        appointmentId: true,
        paymentId: true,
        consulteeProfileId: true,
      },
    });
    if (!trial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 },
      );
    }

    const windowRefusal = await trialCancelWindowRefusal(trial.appointmentId);
    if (windowRefusal) {
      return NextResponse.json(
        { error: windowRefusal.userMessage, code: windowRefusal.code },
        { status: windowRefusal.httpStatus, ...NO_STORE },
      );
    }

    const quote = await quoteTrialRefund({
      appointmentId: trial.appointmentId,
      paymentId: trial.paymentId,
      // DELETE's own rule: only the consultee's cancel is consultee-initiated.
      isConsultantInitiated:
        session.user.consulteeProfileId !== trial.consulteeProfileId,
    });

    // A `free_` ₹0 payment covers a free trial and a credit-funded one; only credit still held tells them apart.
    const freeBooking =
      !!quote &&
      quote.fundingRail === "CREDITS" &&
      quote.grossPaise === 0 &&
      (await creditStillUsedPaise(prisma, quote.paymentId)) === 0;
    // `expectedPaid` rides back with the click, so DELETE can tell a paid screen from an unpaid one.
    return NextResponse.json(
      quote
        ? { paid: true, ...quote, freeBooking, expectedPaid: true }
        : { paid: false },
      NO_STORE,
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "trials",
      op: "GET /api/trials/[trialId]/cancel/preview",
    });
    return NextResponse.json(
      { error: "Could not estimate the refund" },
      { status: 500 },
    );
  }
}
