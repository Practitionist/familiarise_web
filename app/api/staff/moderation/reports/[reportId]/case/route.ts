import { NextRequest, NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import {
  openReportCaseTx,
  readReportCaseOptions,
} from "@/lib/moderation/report-case";
import { reportSentryError } from "@/lib/observability/report";
import { OpenReportCaseShape } from "@/schemas/moderation";

interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/** The open-case dialog's data: the linked case, or the bookings reporter and target share. */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireBackofficeSurface("tickets.manage");
  if (auth.error) return auth.error;
  const { reportId } = await params;
  try {
    const options = await readReportCaseOptions(reportId);
    if (!options) {
      return NextResponse.json(
        { error: "Report not found.", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json(options);
  } catch (err) {
    reportSentryError(err, { subsystem: "moderation", op: "report-case:read" });
    return NextResponse.json(
      { error: "Something went wrong — please try again.", code: "FAILED" },
      { status: 500 },
    );
  }
}

/** Opens the reporter's support case on a booking both users share, once per report. */
export const POST = withOpsAction(
  "tickets.manage",
  "moderation.report.open-case",
  OpenReportCaseShape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const { linkedCase } = await openReportCaseTx(tx, {
        reportId: params.reportId,
        appointmentId: body.appointmentId,
        category: body.category,
        actorUserId: actor.userId,
      });
      return {
        target: { kind: "ModerationReport", id: params.reportId },
        response: { case: linkedCase },
        status: 201,
        before: { caseId: null },
        after: {
          caseId: linkedCase.id,
          appointmentId: body.appointmentId,
          category: body.category,
        },
        correlationId: `support-case:${linkedCase.id}`,
      };
    },
  },
);
